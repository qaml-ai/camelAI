import { describe, expect, it } from 'vitest';
import {
  getSpreadsheetDelimiter,
  parseDelimitedRows,
} from '@/components/chat-file-preview/spreadsheet';

describe('spreadsheet-preview parser', () => {
  it('chooses delimiter from extension or mime type', () => {
    expect(getSpreadsheetDelimiter('data.tsv')).toBe('\t');
    expect(getSpreadsheetDelimiter('data', 'text/tab-separated-values')).toBe('\t');
    expect(getSpreadsheetDelimiter('data.csv', 'text/csv')).toBe(',');
    expect(getSpreadsheetDelimiter('data')).toBe(',');
  });

  it('returns no rows for empty content', () => {
    expect(parseDelimitedRows('', ',')).toEqual([]);
  });

  it('parses comma-delimited rows', () => {
    expect(parseDelimitedRows('name,amount\nWidget,12.5\nGadget,9', ',')).toEqual([
      ['name', 'amount'],
      ['Widget', '12.5'],
      ['Gadget', '9'],
    ]);
  });

  it('parses quoted fields with commas and escaped quotes', () => {
    expect(
      parseDelimitedRows('name,notes\n"Widget, A","Says ""hello"""', ',')
    ).toEqual([
      ['name', 'notes'],
      ['Widget, A', 'Says "hello"'],
    ]);
  });

  it('parses quoted fields with embedded newlines', () => {
    expect(parseDelimitedRows('name,notes\nWidget,"Line 1\nLine 2"', ',')).toEqual([
      ['name', 'notes'],
      ['Widget', 'Line 1\nLine 2'],
    ]);
  });

  it('parses tab-delimited rows', () => {
    expect(parseDelimitedRows('name\tcount\nalpha\t2', '\t')).toEqual([
      ['name', 'count'],
      ['alpha', '2'],
    ]);
  });
});
