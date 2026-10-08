import { describe, expect, it } from 'vitest';
import { findControl, findItem } from './apply.ts';
import type { DeviceParameterState } from '@openflow/protocol';

const param = (name: string): DeviceParameterState => ({ name, value: 0, min: 0, max: 1, quantized: false }) as DeviceParameterState;

const params = [param('Device On'), param('Input Gain'), param('Gain'), param('Ceiling')];

describe('findControl', () => {
  it('finds a control case-insensitively, with its index', () => {
    expect(findControl(params, ['ceiling'])).toEqual({ p: 3, parameter: params[3] });
  });

  it('takes the first candidate the device has, in candidate order', () => {
    expect(findControl(params, ['Makeup', 'Gain', 'Input Gain'])).toEqual({ p: 2, parameter: params[2] });
    expect(findControl(params, ['Input Gain', 'Gain'])).toEqual({ p: 1, parameter: params[1] });
  });

  it('matches whole names only', () => {
    expect(findControl(params, ['Gai'])).toBeNull();
  });

  it('is null when no candidate matches', () => {
    expect(findControl(params, ['Release', 'Lookahead'])).toBeNull();
    expect(findControl([], ['Gain'])).toBeNull();
  });
});

describe('findItem', () => {
  const items = ['Low Cut 48', 'Low Shelf', 'Bell', 'High Shelf', 'High Cut 12'];

  it('matches a substring case-insensitively', () => {
    expect(findItem(items, ['bell'])).toBe(2);
    expect(findItem(items, ['cut 12'])).toBe(4);
  });

  it('takes the first candidate that matches, in candidate order', () => {
    expect(findItem(items, ['Notch', 'High Shelf', 'Bell'])).toBe(3);
  });

  it('takes the first item a candidate is in', () => {
    expect(findItem(items, ['shelf'])).toBe(1);
  });

  it('is -1 when none matches', () => {
    expect(findItem(items, ['Notch'])).toBe(-1);
    expect(findItem([], ['Bell'])).toBe(-1);
  });
});
