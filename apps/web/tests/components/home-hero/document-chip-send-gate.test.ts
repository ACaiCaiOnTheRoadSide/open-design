import { describe, expect, it } from 'vitest';
import type { InputFieldSpec } from '@open-design/contracts';

import { findChip } from '../../../src/components/home-hero/chips';
import { pluginInputsAreValid } from '../../../src/utils/pluginRequiredInputs';

// Regression guard for the "Document template can't send" bug.
//
// The Document chip binds the generic `od-new-generation` scenario, whose
// manifest declares `artifactKind` / `audience` / `topic` as REQUIRED inputs
// with NO defaults. The Home composer dropped its inline plugin-inputs form
// (`footerInputNamesForChip` returns []), so an apply-scenario chip that binds
// a required-input plugin without seeding those inputs leaves
// `pluginInputsAreValid` false forever. That flips `active.inputsValid` false,
// which HomeView forwards as `submitDisabled` — the Send button stays disabled
// ("Type something to run") even after the user types a brief.
//
// The invariant: the Document chip must SEED od-new-generation's required
// inputs on bind. Mirrors plugins/_official/scenarios/od-new-generation
// (required, no manifest default).
const OD_NEW_GENERATION_REQUIRED_INPUTS: InputFieldSpec[] = [
  { name: 'artifactKind', type: 'string', required: true },
  { name: 'audience', type: 'string', required: true },
  { name: 'topic', type: 'string', required: true },
];

describe('Document chip send gate', () => {
  it('seeds every required od-new-generation input so Home Send is not dead-locked', () => {
    const document = findChip('document');
    expect(document, 'the Document chip must exist in the catalog').toBeTruthy();
    expect(document?.action.kind).toBe('apply-scenario');

    const seeded =
      document?.action.kind === 'apply-scenario' ? document.action.inputs ?? {} : {};

    // This is the exact production gate: HomeView computes
    // `active.inputsValid = pluginInputsAreValid(inputFields, inputs)` and
    // disables the composer when it is false. Without the seed the required
    // inputs are missing and this returns false → Send permanently disabled.
    expect(pluginInputsAreValid(OD_NEW_GENERATION_REQUIRED_INPUTS, seeded)).toBe(true);
  });
});
