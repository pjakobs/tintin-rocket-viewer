import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { expandLdr, parseCsv } from './crosscheck.js';

// Builds a "1 <color> <12 numeric matrix fields> <filename>" placement line —
// expandLdr only cares that there are 13 numeric fields before the filename.
function place(filename, color = '16') {
  const matrix = Array(12).fill('0').join(' ');
  return `1 ${color} ${matrix} ${filename}`;
}

describe('expandLdr', () => {
  it('counts leaf parts referenced directly by the root', () => {
    const text = [
      '0 FILE main.ldr',
      place('3001.dat'),
      place('3001.dat'),
      place('3002.dat'),
    ].join('\n');
    const { counts, total, unique } = expandLdr(text);
    expect(counts['3001.dat']).toBe(2);
    expect(counts['3002.dat']).toBe(1);
    expect(total).toBe(3);
    expect(unique).toBe(2);
  });

  it('recurses into submodels and multiplies quantities', () => {
    // main.ldr places sub.ldr twice; sub.ldr places 3001.dat three times.
    // Each leaf count should be multiplied by every enclosing placement.
    const text = [
      '0 FILE main.ldr',
      place('sub.ldr'),
      place('sub.ldr'),
      '0 FILE sub.ldr',
      place('3001.dat'),
      place('3001.dat'),
      place('3001.dat'),
    ].join('\n');
    const { counts, total } = expandLdr(text);
    expect(counts['3001.dat']).toBe(6);
    expect(total).toBe(6);
  });

  it('treats everything after the 13 numeric params as the filename, spaces included', () => {
    const text = [
      '0 FILE main.ldr',
      place('sub model with spaces.ldr'),
      '0 FILE sub model with spaces.ldr',
      place('3001.dat'),
    ].join('\n');
    const { counts, total } = expandLdr(text);
    expect(counts['3001.dat']).toBe(1);
    expect(total).toBe(1);
  });

  it('uses the first "0 FILE" as the root even when later submodels are defined first in a different order', () => {
    const text = [
      '0 FILE main.ldr',
      place('3001.dat'),
      '0 FILE unused.ldr',
      place('9999.dat'),
    ].join('\n');
    const { counts } = expandLdr(text);
    expect(counts['3001.dat']).toBe(1);
    expect(counts['9999.dat']).toBeUndefined();
  });

  it('falls back to a synthetic __root__ path when there is no "0 FILE" header at all', () => {
    const text = [place('3001.dat'), place('3002.dat')].join('\n');
    const { counts, total } = expandLdr(text);
    expect(counts['3001.dat']).toBe(1);
    expect(counts['3002.dat']).toBe(1);
    expect(total).toBe(2);
  });
});

describe('expandLdr on the real model', () => {
  it('locks the total brick count the README, HUD and architecture doc all quote', () => {
    const path = fileURLToPath(new URL('../public/model/tintin-rocket.ldr', import.meta.url));
    const text = readFileSync(path, 'utf8');
    expect(expandLdr(text).total).toBe(1181);
  });
});

describe('parseCsv', () => {
  const header = 'Part,Color,Quantity,Is Spare';

  it('sums quantities and excludes spares from the total', () => {
    const text = [
      header,
      '3001,Red,4,false',
      '3002,Blue,2,true',
    ].join('\n');
    const { counts, total, spares, unique } = parseCsv(text);
    expect(counts['3001']).toBe(4);
    expect(counts['3002']).toBeUndefined();
    expect(total).toBe(4);
    expect(spares).toBe(2);
    expect(unique).toBe(1);
  });

  it('sums duplicate rows for the same part', () => {
    const text = [
      header,
      '3001,Red,4,false',
      '3001,Blue,3,false',
    ].join('\n');
    const { counts, total, unique } = parseCsv(text);
    expect(counts['3001']).toBe(7);
    expect(total).toBe(7);
    expect(unique).toBe(1);
  });
});
