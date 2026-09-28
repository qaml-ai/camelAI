
import { getFileExtension } from '../file-type-utils';
import { parseDelimitedWorkbook } from './parse-delimited';
import { parseExcelWorkbook } from './parse-excel.client';
import type { SpreadsheetWorkbook } from './types';

export function parseSpreadsheetWorkbook(
  content: string | ArrayBuffer,
  filename: string,
  contentType?: string,
): SpreadsheetWorkbook | null {
  const extension = getFileExtension(filename);
  if (content instanceof ArrayBuffer || extension === 'xlsx' || extension === 'xls') {
    if (!(content instanceof ArrayBuffer)) return null;
    return parseExcelWorkbook(content);
  }
  return parseDelimitedWorkbook(content, filename, contentType);
}
