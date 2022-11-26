/**
 *
 * @license
 * Copyright 2020 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as tf from '@tensorflow/tfjs';
import {Tensor3D} from '@tensorflow/tfjs';

import {hzToMidi} from '../core/audio_utils';
import {shiftF0} from '../spice/pitch_utils';
import {MODEL_FRAME_RATE} from '../spice/spice';

import {CONF_SMOOTH_SIZE, CONF_THRESHOLD, LD_CONF_REDUCTION, LOWEST_LD, MIN_VRAM,} from './constants';
import {AudioFeatures, ModelValues} from './interfaces';

async function memCheck() {
  const bytesPerMB = 1024 * 1024;
  const screenResToVRAMFactor = 600;
  const screenSize = window.screen.availWidth * window.screen.availHeight;
  const DPI = window.devicePixelRatio;

  // Checking of vram ensures that the device can hold
  // all the models and operations.
  const vramSize =
      Math.round((screenSize * DPI * screenResToVRAMFactor) / bytesPerMB);

  if (!isNaN(vramSize) && vramSize < MIN_VRAM) {
    throw new Error(`Insufficient memory! Your device has ${
        vramSize} and recommended memory is ${MIN_VRAM}`);
  }

  // Check if the browser supports the WebGL Engine.
  try {
    await tf.ready();

    if (tf.getBackend() !== 'webgl') {
      throw new Error('It looks like your browser does not support webgl.');
    }
  } catch (err) {
    throw new Error(`insufficient memory - ${err}`);
  }

  return true;
}

export async function getModel(url: string) {
  const model = await tf.loadGraphModel(url);
  return model;
}

function resizeAudioFeatures(
    audioFeatures: AudioFeatures, startingFrame: number, endingFrame: number,
    isLastChunks: boolean, resizedLength: number): Promise<AudioFeatures> {
  return new Promise((resolve) => {
    const resizedAudioFeatures = {
      loudness_db: [0],
      f0_hz: [0],
    };
    let counter = 0;
    for (let i = startingFrame; i < endingFrame; i++) {
      if (isLastChunks && i >= resizedLength) {
        resizedAudioFeatures.loudness_db[counter] = LOWEST_LD;
        resizedAudioFeatures.f0_hz[counter] = -1;
      } else {
        resizedAudioFeatures.loudness_db[counter] =
            audioFeatures.loudness_db[i];
        resizedAudioFeatures.f0_hz[counter] = audioFeatures.f0_hz[i];
      }
      counter += 1;
    }

    resolve(resizedAudioFeatures);
  });
}

async function normalizeAudioFeatures(af: AudioFeatures, model: ModelValues) {
  const SELECTED_LD_AVG_MAX = model.averageMaxLoudness;
  const SELECTED_LD_MEAN = model.meanLoudness;
  const SELECTED_LD_THRESH = model.loudnessThreshold;
  const SELECTED_P_MEAN = model.meanPitch;

  // tslint:disable-next-line: variable-name
  let loudness_db: number[] = [];
  let maskedPower;

  if (af.loudness_db.length > 0) {
    // Adjust the peak loudness.
    const ldShifted = tf.tidy(() => {
      const inputLoudnessTensor = tf.tensor1d(af.loudness_db, 'float32');
      const ldMax = inputLoudnessTensor.max();
      const ldDiffMax = tf.sub(SELECTED_LD_AVG_MAX, ldMax);
      // shift the max of power_db from user down to max of instrument power_db
      const final = tf.add(inputLoudnessTensor, ldDiffMax);
      inputLoudnessTensor.dispose();
      ldMax.dispose();
      ldDiffMax.dispose();

      return final;  // af.loudness_db.add(ldDiffMax)
    });

    // Further adjust the average loudness above a threshold.
    const ldShiftedGreater = ldShifted.greater(SELECTED_LD_THRESH);
    const ldGreater = await tf.booleanMaskAsync(ldShifted, ldShiftedGreater);
    const ldGreaterVal = await ldGreater.array();

    const ldFinal = tf.tidy(() => {
      const ldMean = ldGreaterVal > 0 ? ldGreater.mean() : ldShifted.mean();

      const ldDiffMean = tf.sub(SELECTED_LD_MEAN, ldMean);
      const ldDiffMeanAdded = ldShifted.add(ldDiffMean);

      const loudnessAdjustment = 0;
      const ldAdjusted = ldDiffMeanAdded.add(loudnessAdjustment);

      const ldClipped = ldAdjusted.clipByValue(LOWEST_LD, SELECTED_LD_AVG_MAX);

      // rescale
      const oldMin = ldClipped.min();
      const subOldMin = ldMean.sub(oldMin);
      return ldClipped.sub(oldMin)
          .div(subOldMin)
          .mul(SELECTED_LD_MEAN - LOWEST_LD)
          .add(LOWEST_LD);
    });

    const reshapedConf = tf.reshape(af.confidences, [-1, 1, 1]);
    const smoothConf =
        tf.pool(reshapedConf as Tensor3D, [CONF_SMOOTH_SIZE, 1], 'avg', 'same');
    const smoothConfReshaped = smoothConf.reshape([-1]);
    const confMask = tf.lessEqual(smoothConfReshaped, CONF_THRESHOLD);

    maskedPower = tf.tidy(() => {
      const confReduction = confMask.mul(LD_CONF_REDUCTION);
      const loudnessReduced = ldFinal.add(confReduction);
      const finalMaskedPower = tf.maximum(loudnessReduced, LOWEST_LD);
      confReduction.dispose();
      loudnessReduced.dispose();
      return finalMaskedPower;
    });

    loudness_db = (await maskedPower.array()) as number[];

    ldShiftedGreater.dispose();
    ldShifted.dispose();
    ldFinal.dispose();
    ldGreater.dispose();
    smoothConf.dispose();
    smoothConfReshaped.dispose();
    reshapedConf.dispose();
    confMask.dispose();
  }
  // tslint:disable-next-line: variable-name
  let f0_hz: number[] = [];
  if (af.f0_hz.length > 0) {
    // shift the pitch register.
    const _p = await hzToMidi(af.f0_hz);

    const p = tf.tidy(() => {
      for (let i = 0, n = _p.length; i < n; ++i) {
        if (_p[i] === -Infinity) {
          _p[i] = 0;
        }
      }

      return _p;
    });

    const confMask = tf.lessEqual(af.confidences, CONF_THRESHOLD);
    const maskedPowerThreshold = maskedPower.greater(SELECTED_LD_THRESH);
    const mask = tf.logicalOr(confMask, maskedPowerThreshold);
    const pMask = await tf.booleanMaskAsync(p, mask);
    const pMean = pMask.mean();
    const pDiff = await tf.sub(SELECTED_P_MEAN, pMean);
    const pDiffVal = await pDiff.array();

    const finalf0 = tf.tidy(() => {
      let pDiffOctave = (pDiffVal as number) / 12;
      pDiffOctave = Math.round(pDiffOctave);
      const shiftedF0WithOctave = shiftF0(af.f0_hz, pDiffOctave);
      return shiftedF0WithOctave;
    });

    f0_hz = (await finalf0.array()) as number[];

    maskedPower.dispose();
    pMean.dispose();
    pMask.dispose();
    pDiff.dispose();
    finalf0.dispose();
    maskedPowerThreshold.dispose();
    mask.dispose();
    confMask.dispose();
  }

  return {f0_hz, loudness_db};
}

function convertSecsToFrame(secs: number) {
  return secs * MODEL_FRAME_RATE;
}
function convertFrameToSecs(frameLength: number) {
  return frameLength / MODEL_FRAME_RATE;
}

export {
  memCheck,
  convertSecsToFrame,
  convertFrameToSecs,
  normalizeAudioFeatures,
  resizeAudioFeatures,
};
