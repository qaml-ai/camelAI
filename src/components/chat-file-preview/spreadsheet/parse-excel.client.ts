
import { read, utils, type CellObject, type WorkBook } from 'xlsx';
import {
  DEFAULT_ROW_HEIGHT,
  MAX_COLUMN_WIDTH,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  MIN_COLUMN_WIDTH,
} from './constants';
import { extractEmbeddedChartsFromWorkbookFiles } from './parse-charts';
import type { SpreadsheetCell, SpreadsheetMerge, SpreadsheetSheet, SpreadsheetWorkbook, WorkbookFileEntry } from './types';
import { clamp, getCellValue } from './utils';

export function normalizeHexColor(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{8}$/.test(trimmed)) return `#${trimmed.slice(2)}`;
  if (!/^[0-9A-F]{6}$/.test(trimmed)) return null;
  return `#${trimmed}`;
}

export function getForegroundForBackground(backgroundColor: string | null) {
  if (!backgroundColor) return null;
  const red = Number.parseInt(backgroundColor.slice(1, 3), 16);
  const green = Number.parseInt(backgroundColor.slice(3, 5), 16);
  const blue = Number.parseInt(backgroundColor.slice(5, 7), 16);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance < 0.52 ? '#F8FAFC' : '#1F2937';
}

export function detectCellAlignment(cell: CellObject | undefined): CanvasTextAlign | null {
  if (!cell) return null;
  if (cell.t === 'n' || cell.t === 'd') return 'right';
  if (cell.t === 'b') return 'center';
  return null;
}

export function stringifyCellValue(cell: CellObject | undefined): SpreadsheetCell | null {
  if (!cell) return null;
  const formula = typeof cell.f === 'string' ? cell.f : null;
  const numberValue = typeof cell.v === 'number' && Number.isFinite(cell.v) ? cell.v : null;
  const style = cell.s as
    | { fgColor?: { rgb?: unknown }; fill?: { fgColor?: { rgb?: unknown } } }
    | undefined;
  const backgroundColor = normalizeHexColor(style?.fill?.fgColor?.rgb ?? style?.fgColor?.rgb);
  const textColor = getForegroundForBackground(backgroundColor);
  const textAlign = detectCellAlignment(cell);
  if (cell.w !== undefined && cell.w !== null && String(cell.w).length > 0) {
    return { value: String(cell.w), formula, numberValue, backgroundColor, textColor, textAlign };
  }
  if (cell.v === undefined || cell.v === null || cell.v === '') {
    return { value: null, formula, numberValue, backgroundColor, textColor, textAlign };
  }
  if (typeof cell.v === 'number') {
    return {
      value: Number.isInteger(cell.v) ? String(cell.v) : cell.v.toFixed(2),
      formula,
      numberValue,
      backgroundColor,
      textColor,
      textAlign,
    };
  }
  if (typeof cell.v === 'boolean') {
    return {
      value: cell.v ? 'TRUE' : 'FALSE',
      formula,
      numberValue,
      backgroundColor,
      textColor,
      textAlign,
    };
  }
  return { value: String(cell.v), formula, numberValue, backgroundColor, textColor, textAlign };
}

export function detectWorkbookRowKinds(
  rows: SpreadsheetCell[][],
  merges: SpreadsheetMerge[],
  columnCount: number,
) {
  return rows.map((row, rowIndex) => {
    const nonEmptyCells = row.filter((cell) => Boolean(getCellValue(cell)));
    if (nonEmptyCells.length === 0) return 'body' as const;

    const fullWidthMerge = merges.find(
      (merge) =>
        merge.startRow === rowIndex &&
        merge.startCol === 0 &&
        merge.endCol >= Math.max(0, columnCount - 1),
    );
    if (fullWidthMerge && nonEmptyCells.length === 1) {
      return 'title' as const;
    }

    const fillColors = nonEmptyCells
      .map((cell) => cell.backgroundColor)
      .filter((value): value is string => Boolean(value));
    const hasUniformFill =
      fillColors.length === nonEmptyCells.length && new Set(fillColors).size === 1;
    const mostlyLabels = nonEmptyCells.every((cell) => {
      const value = getCellValue(cell);
      return value.length > 0 && !/[\d$%]/.test(value);
    });

    if (nonEmptyCells.length >= Math.min(3, columnCount) && hasUniformFill && mostlyLabels) {
      return 'header' as const;
    }

    return 'body' as const;
  });
}

export function parseWorkbookSheet(workbook: WorkBook, sheetName: string): SpreadsheetSheet {
  const worksheet = workbook.Sheets[sheetName];
  const ref = worksheet?.['!ref'];
  if (!worksheet || !ref) {
    return {
      name: sheetName,
      rows: [],
      rowCount: 0,
      columnCount: 0,
      sourceStartRow: 0,
      sourceStartCol: 0,
      rowHeights: [],
      columnWidths: [],
      merges: [],
      rowKinds: [],
      isFirstRowHeader: false,
      wasTrimmed: false,
    };
  }

  const range = utils.decode_range(ref);
  const sourceStartRow = range.s.r;
  const sourceStartCol = range.s.c;
  const sourceRowCount = Math.max(0, range.e.r - range.s.r + 1);
  const sourceColumnCount = Math.max(0, range.e.c - range.s.c + 1);
  const rowCount = Math.min(sourceRowCount, MAX_SHEET_ROWS);
  const columnCount = Math.min(sourceColumnCount, MAX_SHEET_COLUMNS);
  const sourceEndRow = sourceStartRow + Math.max(rowCount - 1, 0);
  const sourceEndCol = sourceStartCol + Math.max(columnCount - 1, 0);
  const wasTrimmed = rowCount < sourceRowCount || columnCount < sourceColumnCount;
  const merges = ((worksheet['!merges'] as Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> | undefined) ?? [])
    .flatMap((merge) => {
      if (
        merge.e.r < sourceStartRow ||
        merge.e.c < sourceStartCol ||
        merge.s.r > sourceEndRow ||
        merge.s.c > sourceEndCol
      ) {
        return [];
      }
      return [{
      startRow: Math.max(merge.s.r, sourceStartRow) - sourceStartRow,
      startCol: Math.max(merge.s.c, sourceStartCol) - sourceStartCol,
      endRow: Math.min(merge.e.r, sourceEndRow) - sourceStartRow,
      endCol: Math.min(merge.e.c, sourceEndCol) - sourceStartCol,
      }];
    });
  const rowHeights = Array.from({ length: rowCount }, (_, rowIndex) => {
    const descriptor = (worksheet['!rows'] as Array<{ hidden?: boolean; hpx?: number } | null> | undefined)?.[
      sourceStartRow + rowIndex
    ];
    if (descriptor?.hidden || descriptor?.hpx === 0) return 0;
    return clamp(Math.round(descriptor?.hpx ?? DEFAULT_ROW_HEIGHT), 22, 56);
  });
  const columnWidths = Array.from({ length: columnCount }, (_, columnIndex) => {
    const descriptor = (worksheet['!cols'] as Array<{ hidden?: boolean; wpx?: number } | undefined> | undefined)?.[
      sourceStartCol + columnIndex
    ];
    if (descriptor?.hidden || descriptor?.wpx === 0) return 0;
    return typeof descriptor?.wpx === 'number'
      ? clamp(Math.round(descriptor.wpx + 14), MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH)
      : undefined;
  });
  const rows: SpreadsheetCell[][] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row: SpreadsheetCell[] = [];
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const address = utils.encode_cell({
        r: sourceStartRow + rowIndex,
        c: sourceStartCol + columnIndex,
      });
      row.push(
        stringifyCellValue(worksheet[address]) ?? {
          value: null,
          formula: null,
          numberValue: null,
          backgroundColor: null,
          textColor: null,
          textAlign: null,
        },
      );
    }
    rows.push(row);
  }

  const rowKinds = detectWorkbookRowKinds(rows, merges, columnCount);

  return {
    name: sheetName,
    rows,
    rowCount,
    columnCount,
    sourceStartRow,
    sourceStartCol,
    rowHeights,
    columnWidths,
    merges,
    rowKinds,
    isFirstRowHeader: false,
    wasTrimmed,
  };
}

export function parseExcelWorkbook(content: ArrayBuffer): SpreadsheetWorkbook | null {
  let workbook: WorkBook;
  try {
    workbook = read(content, {
      type: 'array',
      cellFormula: true,
      cellStyles: true,
      bookFiles: true,
      sheetStubs: true,
      raw: false,
    });
  } catch {
    return null;
  }

  const sheets = workbook.SheetNames.map((sheetName) => parseWorkbookSheet(workbook, sheetName));
  if (sheets.length === 0) return null;
  const embeddedCharts = extractEmbeddedChartsFromWorkbookFiles(
    (workbook as WorkBook & { files?: Record<string, WorkbookFileEntry> }).files,
    workbook.SheetNames,
    sheets,
  );
  return {
    kind: 'excel',
    sheets,
    charts: embeddedCharts,
  };
}
