import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { utils, write, type WorkSheet } from 'xlsx';
import { FilePreviewContent } from '@/components/chat-file-preview/file-preview-content';
import { SpreadsheetCanvasSurface } from '@/components/chat-file-preview/spreadsheet/canvas-surface';
import {
  SpreadsheetChartGraphic,
  SpreadsheetChartsSurface,
} from '@/components/chat-file-preview/spreadsheet/chart-surface';
import {
  extractEmbeddedChartsFromWorkbookFiles,
  parseSpreadsheetWorkbook,
  SpreadsheetPreview,
} from '@/components/chat-file-preview/spreadsheet';
import { parseWorkbookSheet } from '@/components/chat-file-preview/spreadsheet/parse-excel';
import { createInitialColumnWidths } from '@/components/chat-file-preview/spreadsheet/utils';

function toArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
}

function createWorkbookBuffer(bookType: 'xlsx' | 'xls' = 'xlsx') {
  const workbook = utils.book_new();
  const suppliersSheet = utils.aoa_to_sheet([
    ['Company', 'Revenue'],
    ['Acme', 42],
    ['Beta', 100],
  ]);
  const summarySheet = utils.aoa_to_sheet([['', 'Label']]);
  summarySheet.A1 = {
    t: 'n',
    f: "SUM('Supplier Stock Tracker'!B2:B3)",
  };
  summarySheet.B1 = {
    t: 's',
    v: 'Total Revenue',
  };
  summarySheet['!ref'] = 'A1:B1';

  utils.book_append_sheet(workbook, suppliersSheet, 'Supplier Stock Tracker');
  utils.book_append_sheet(workbook, summarySheet, 'Summary');

  return toArrayBuffer(write(workbook, { type: 'array', bookType }));
}

function mockCanvasContext() {
  const context = {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    clip: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    rect: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setTransform: vi.fn(),
    strokeRect: vi.fn(),
  };
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => context as unknown as CanvasRenderingContext2D),
  });
}

describe('spreadsheet preview renderer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasContext();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses legacy xls workbooks', () => {
    const workbook = parseSpreadsheetWorkbook(createWorkbookBuffer('xls'), 'legacy.xls');
    expect(workbook?.kind).toBe('excel');
    expect(workbook?.sheets[0]?.rows[1]?.[0]?.value).toBe('Acme');
  });

  it('returns null for malformed excel workbooks', () => {
    const invalidZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]).buffer;
    expect(parseSpreadsheetWorkbook(invalidZip, 'broken.xlsx')).toBeNull();
  });

  it('parses workbook sheets whose used range starts below and right of A1', () => {
    const workbook = utils.book_new();
    const offsetSheet: WorkSheet = {
      C5001: { t: 's', v: 'Company' },
      D5001: { t: 's', v: 'Revenue' },
      C5002: { t: 's', v: 'Acme' },
      D5002: { t: 'n', v: 42 },
      '!ref': 'C5001:D5002',
    };
    utils.book_append_sheet(workbook, offsetSheet, 'Offset');

    const parsed = parseSpreadsheetWorkbook(
      toArrayBuffer(write(workbook, { type: 'array', bookType: 'xlsx' })),
      'offset.xlsx'
    );
    const sheet = parsed?.sheets[0];

    expect(sheet?.sourceStartRow).toBe(5000);
    expect(sheet?.sourceStartCol).toBe(2);
    expect(sheet?.rowCount).toBe(2);
    expect(sheet?.columnCount).toBe(2);
    expect(sheet?.rows[0]?.[0]?.value).toBe('Company');
    expect(sheet?.rows[1]?.[1]?.value).toBe('42');
    expect(sheet?.rows[1]?.[1]?.numberValue).toBe(42);
  });

  it('preserves hidden Excel row and column dimensions', () => {
    const offsetSheet: WorkSheet = {
      A1: { t: 's', v: 'Visible A' },
      B1: { t: 's', v: 'Hidden B' },
      C1: { t: 's', v: 'Visible C' },
      A2: { t: 's', v: 'Hidden row' },
      B2: { t: 's', v: 'Hidden row and column' },
      C2: { t: 's', v: 'Hidden row' },
      A3: { t: 's', v: 'Visible A3' },
      B3: { t: 's', v: 'Hidden B3' },
      C3: { t: 's', v: 'Visible C3' },
      '!ref': 'A1:C3',
      '!rows': [{}, { hidden: true, hpx: 44 }, {}],
      '!cols': [{ wpx: 90 }, { hidden: true, wpx: 120 }, {}],
    };

    const sheet = parseWorkbookSheet(
      { SheetNames: ['Hidden'], Sheets: { Hidden: offsetSheet } },
      'Hidden'
    );
    const initialColumnWidths = createInitialColumnWidths(sheet);

    expect(sheet.rowHeights).toEqual([22, 0, 22]);
    expect(sheet.columnWidths).toEqual([104, 0, undefined]);
    expect(initialColumnWidths[0]).toBe(104);
    expect(initialColumnWidths[1]).toBe(0);
    expect(initialColumnWidths[2]).toBeGreaterThan(0);
  });

  it('reads cell background colors from Excel fill styles', () => {
    const styledSheet: WorkSheet = {
      A1: { t: 's', v: 'Company', s: { fill: { fgColor: { rgb: 'FF1F2937' } } } },
      B1: { t: 's', v: 'Revenue', s: { fill: { fgColor: { rgb: 'FF1F2937' } } } },
      C1: { t: 's', v: 'Owner', s: { fill: { fgColor: { rgb: 'FF1F2937' } } } },
      A2: { t: 's', v: 'Acme' },
      B2: { t: 'n', v: 42 },
      C2: { t: 's', v: 'Sam' },
      '!ref': 'A1:C2',
    };

    const sheet = parseWorkbookSheet(
      { SheetNames: ['Styled'], Sheets: { Styled: styledSheet } },
      'Styled'
    );

    expect(sheet.rows[0]?.[0]?.backgroundColor).toBe('#1F2937');
    expect(sheet.rows[0]?.[0]?.textColor).toBe('#F8FAFC');
    expect(sheet.rowKinds[0]).toBe('header');
  });

  it('renders the workbook shell with sheet tabs and formula bar content', async () => {
    render(
      <SpreadsheetPreview
        content={createWorkbookBuffer()}
        filename="suppliers.xlsx"
        layout="panel"
      />
    );

    expect(screen.getByRole('tab', { name: 'Supplier Stock Tracker' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Summary' })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('A1')).toBeInTheDocument();
      expect(screen.getByTestId('spreadsheet-formula-bar')).toHaveValue('Company');
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Summary' }));

    await waitFor(() => {
      expect(screen.getByTestId('spreadsheet-formula-bar')).toHaveValue(
        "=SUM('Supplier Stock Tracker'!B2:B3)"
      );
    });
  });

  it('supports keyboard navigation, range extension, and copy', async () => {
    render(
      <SpreadsheetPreview
        content={createWorkbookBuffer()}
        filename="suppliers.xlsx"
        layout="panel"
      />
    );

    const grid = screen.getByRole('grid', { name: 'Spreadsheet grid' });
    const writeText = vi.mocked(navigator.clipboard.writeText);

    grid.focus();
    fireEvent.keyDown(grid, { key: 'ArrowRight' });

    await waitFor(() => {
      expect(screen.getByText('B1')).toBeInTheDocument();
      expect(screen.getByTestId('spreadsheet-formula-bar')).toHaveValue('Revenue');
    });

    fireEvent.keyDown(grid, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(grid, { key: 'c', metaKey: true });

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('Revenue\n42');
    });
  });

  it('uses scrolled sheet coordinates for pointer selection', async () => {
    render(
      <SpreadsheetCanvasSurface
        workbook={{
          kind: 'excel',
          charts: [],
          sheets: [
            {
              name: 'Sheet1',
              rows: [
                [
                  { value: 'A1', numberValue: null },
                  { value: 'B1', numberValue: null },
                  { value: 'C1', numberValue: null },
                ],
                [
                  { value: 'A2', numberValue: null },
                  { value: 'B2', numberValue: null },
                  { value: 'C2', numberValue: null },
                ],
                [
                  { value: 'A3', numberValue: null },
                  { value: 'B3', numberValue: null },
                  { value: 'C3', numberValue: null },
                ],
              ],
              rowCount: 3,
              columnCount: 3,
              rowHeights: [22, 22, 22],
              columnWidths: [64, 64, 64],
              merges: [],
              rowKinds: ['body', 'body', 'body'],
              isFirstRowHeader: false,
              wasTrimmed: false,
            },
          ],
        }}
        layout="panel"
      />
    );

    const grid = screen.getByRole('grid', { name: 'Spreadsheet grid' });
    grid.setPointerCapture = vi.fn();
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 200,
      right: 300,
      width: 300,
      height: 200,
      toJSON: () => ({}),
    });
    grid.scrollLeft = 64;
    grid.scrollTop = 22;

    fireEvent.pointerDown(grid, {
      button: 0,
      clientX: 72,
      clientY: 35,
      pointerId: 1,
    });

    await waitFor(() => {
      expect(screen.getByText('B2')).toBeInTheDocument();
      expect(screen.getByTestId('spreadsheet-formula-bar')).toHaveValue('B2');
    });
  });

  it('fetches xlsx previews as binary data', async () => {
    const arrayBuffer = vi.fn().mockResolvedValue(createWorkbookBuffer());
    const text = vi.fn().mockResolvedValue('');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer,
        text,
      })
    );

    render(
      <FilePreviewContent
        filename="suppliers.xlsx"
        previewUrl="/preview/suppliers.xlsx"
        contentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        layout="panel"
      />
    );

    await waitFor(() => {
      expect(arrayBuffer).toHaveBeenCalledTimes(1);
    });
    expect(text).not.toHaveBeenCalled();
  });

  it('does not invent charts when a workbook has no embedded charts', () => {
    render(
      <SpreadsheetPreview
        content={createWorkbookBuffer()}
        filename="suppliers.xlsx"
        layout="panel"
      />
    );

    expect(screen.queryByRole('tab', { name: 'Charts' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('spreadsheet-chart-workspace')).not.toBeInTheDocument();
  });

  it('renders one active chart with chart tabs for multi-chart workbooks', () => {
    render(
      <SpreadsheetChartsSurface
        charts={[
          {
            id: 'chart-1',
            kind: 'pie',
            title: 'Revenue Chart',
            sheetName: 'Summary',
            categoryLabel: 'Slice',
            categories: ['Q1', 'Q2'],
            series: [{ name: 'Revenue', values: [12, 18], color: 'var(--chart-1)' }],
            source: 'embedded',
          },
          {
            id: 'chart-2',
            kind: 'pie',
            title: 'Cost Chart',
            sheetName: 'Expenses',
            categoryLabel: 'Slice',
            categories: ['Rent', 'Travel'],
            series: [{ name: 'Costs', values: [8, 5], color: 'var(--chart-2)' }],
            source: 'embedded',
          },
        ]}
      />
    );

    expect(screen.getAllByTestId('spreadsheet-chart-workspace')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: /Revenue Chart/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Cost Chart/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Revenue Chart' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Cost Chart/ }));

    expect(screen.getAllByTestId('spreadsheet-chart-workspace')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Cost Chart' })).toBeInTheDocument();
  });

  it('renders all series for embedded bar charts', () => {
    render(
      <SpreadsheetChartGraphic
        chart={{
          id: 'multi-series-bar',
          kind: 'bar',
          title: 'Quarterly Revenue',
          sheetName: 'Summary',
          categoryLabel: 'Quarter',
          categories: ['Q1', 'Q2'],
          series: [
            { name: 'North', values: [10, 15], color: 'var(--chart-1)' },
            { name: 'South', values: [8, 13], color: 'var(--chart-2)' },
          ],
          source: 'embedded',
        }}
      />
    );

    expect(screen.getAllByTestId('spreadsheet-chart-datum')).toHaveLength(4);
  });

  it('extracts embedded excel charts from workbook relationship files', () => {
    const charts = extractEmbeddedChartsFromWorkbookFiles(
      {
        'xl/worksheets/_rels/sheet1.xml.rels': {
          content: `<Relationships>
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml" />
          </Relationships>`,
        },
        'xl/drawings/_rels/drawing1.xml.rels': {
          content: `<Relationships>
            <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml" />
            <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart2.xml" />
          </Relationships>`,
        },
        'xl/charts/chart1.xml': {
          content: `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
            <c:chart>
              <c:title><c:tx><c:rich><a:p><a:r><a:t>Quarterly Revenue</a:t></a:r></a:p></c:rich></c:tx></c:title>
              <c:plotArea>
                <c:barChart>
                  <c:ser>
                    <c:tx><c:v>Revenue</c:v></c:tx>
                    <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>
                    <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>12</c:v></c:pt><c:pt idx="1"><c:v>18</c:v></c:pt></c:numCache></c:numRef></c:val>
                  </c:ser>
                </c:barChart>
              </c:plotArea>
            </c:chart>
          </c:chartSpace>`,
        },
        'xl/charts/chart2.xml': {
          content: `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
            <c:chart>
              <c:title><c:tx><c:rich><a:p><a:r><a:t>Expense Share</a:t></a:r></a:p></c:rich></c:tx></c:title>
              <c:plotArea>
                <c:pie3DChart>
                  <c:ser>
                    <c:tx><c:v>Expenses</c:v></c:tx>
                    <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Meals</c:v></c:pt><c:pt idx="1"><c:v>Travel</c:v></c:pt></c:strCache></c:strRef></c:cat>
                    <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>30</c:v></c:pt><c:pt idx="1"><c:v>70</c:v></c:pt></c:numCache></c:numRef></c:val>
                  </c:ser>
                </c:pie3DChart>
              </c:plotArea>
            </c:chart>
          </c:chartSpace>`,
        },
      },
      ['Revenue']
    );

    expect(charts).toHaveLength(2);
    expect(charts[0]).toMatchObject({
      title: 'Quarterly Revenue',
      kind: 'bar',
      sheetName: 'Revenue',
      source: 'embedded',
      categories: ['Q1', 'Q2'],
    });
    expect(charts[0]?.series[0]?.values).toEqual([12, 18]);
    expect(charts[1]).toMatchObject({
      title: 'Expense Share',
      kind: 'pie',
      source: 'embedded',
      categories: ['Meals', 'Travel'],
    });
  });

  it('preserves blank embedded chart cache points by index', () => {
    const charts = extractEmbeddedChartsFromWorkbookFiles(
      {
        'xl/worksheets/_rels/sheet1.xml.rels': {
          content: `<Relationships>
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml" />
          </Relationships>`,
        },
        'xl/drawings/_rels/drawing1.xml.rels': {
          content: `<Relationships>
            <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml" />
          </Relationships>`,
        },
        'xl/charts/chart1.xml': {
          content: `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
            <c:chart>
              <c:plotArea>
                <c:barChart>
                  <c:ser>
                    <c:cat><c:strRef><c:strCache><c:ptCount val="4"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="2"><c:v>Q3</c:v></c:pt><c:pt idx="3"><c:v>Q4</c:v></c:pt></c:strCache></c:strRef></c:cat>
                    <c:val><c:numRef><c:numCache><c:ptCount val="4"/><c:pt idx="0"><c:v>12</c:v></c:pt><c:pt idx="1"><c:v/></c:pt><c:pt idx="2"><c:v>18</c:v></c:pt><c:pt idx="3"><c:v>24</c:v></c:pt></c:numCache></c:numRef></c:val>
                  </c:ser>
                </c:barChart>
              </c:plotArea>
            </c:chart>
          </c:chartSpace>`,
        },
      },
      ['Revenue']
    );

    expect(charts).toHaveLength(1);
    expect(charts[0]?.categories).toEqual(['Q1', '', 'Q3', 'Q4']);
    expect(charts[0]?.series[0]?.values).toEqual([12, null, 18, 24]);
  });

  it('resolves embedded chart ranges when OOXML caches are empty', () => {
    const charts = extractEmbeddedChartsFromWorkbookFiles(
      {
        'xl/worksheets/_rels/sheet1.xml.rels': {
          content: `<Relationships>
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml" />
          </Relationships>`,
        },
        'xl/drawings/_rels/drawing1.xml.rels': {
          content: `<Relationships>
            <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml" />
          </Relationships>`,
        },
        'xl/charts/chart1.xml': {
          content: `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
            <c:chart>
              <c:plotArea>
                <c:pieChart>
                  <c:ser>
                    <c:cat><c:strRef><c:f>'No Cache'!$A$1:$A$4</c:f></c:strRef></c:cat>
                    <c:val><c:numRef><c:f>'No Cache'!$B$1:$B$4</c:f><c:numCache/></c:numRef></c:val>
                  </c:ser>
                </c:pieChart>
              </c:plotArea>
            </c:chart>
          </c:chartSpace>`,
        },
      },
      ['No Cache'],
      [
        {
          name: 'No Cache',
          rows: [
            [
              { value: 'Meals', numberValue: null },
              { value: '30', numberValue: 30 },
            ],
            [
              { value: null, numberValue: null },
              { value: '50', numberValue: 50 },
            ],
            [
              { value: 'Supplies', numberValue: null },
              { value: 'n/a', numberValue: null },
            ],
            [
              { value: 'Lodging', numberValue: null },
              { value: '70', numberValue: 70 },
            ],
          ],
          rowCount: 4,
          columnCount: 2,
          rowHeights: [22, 22, 22, 22],
          columnWidths: [64, 64],
          merges: [],
          rowKinds: ['body', 'body', 'body', 'body'],
          isFirstRowHeader: false,
          wasTrimmed: false,
        },
      ]
    );

    expect(charts).toHaveLength(1);
    expect(charts[0]?.categories).toEqual(['Meals', '', 'Supplies', 'Lodging']);
    expect(charts[0]?.series[0]?.values).toEqual([30, 50, null, 70]);
  });

  it('resolves embedded chart relationships from workbook worksheet metadata', () => {
    const charts = extractEmbeddedChartsFromWorkbookFiles(
      {
        'xl/workbook.xml': {
          content: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
            <sheets>
              <sheet name="Actual Sheet" sheetId="7" r:id="rId7" />
            </sheets>
          </workbook>`,
        },
        'xl/_rels/workbook.xml.rels': {
          content: `<Relationships>
            <Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet42.xml" />
          </Relationships>`,
        },
        'xl/worksheets/_rels/sheet42.xml.rels': {
          content: `<Relationships>
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing42.xml" />
          </Relationships>`,
        },
        'xl/drawings/_rels/drawing42.xml.rels': {
          content: `<Relationships>
            <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart42.xml" />
          </Relationships>`,
        },
        'xl/charts/chart42.xml': {
          content: `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
            <c:chart>
              <c:title><c:tx><c:rich><a:p><a:r><a:t>Metadata Chart</a:t></a:r></a:p></c:rich></c:tx></c:title>
              <c:plotArea>
                <c:barChart>
                  <c:ser>
                    <c:tx><c:v>Revenue</c:v></c:tx>
                    <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt></c:strCache></c:strRef></c:cat>
                    <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>12</c:v></c:pt></c:numCache></c:numRef></c:val>
                  </c:ser>
                </c:barChart>
              </c:plotArea>
            </c:chart>
          </c:chartSpace>`,
        },
      },
      ['Actual Sheet']
    );

    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({
      title: 'Metadata Chart',
      sheetName: 'Actual Sheet',
      categories: ['Q1'],
    });
  });

  it('resolves embedded chart relationships from workbook chartsheet metadata', () => {
    const charts = extractEmbeddedChartsFromWorkbookFiles(
      {
        'xl/workbook.xml': {
          content: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
            <sheets>
              <sheet name="Standalone Chart" sheetId="3" r:id="rId3" />
            </sheets>
          </workbook>`,
        },
        'xl/_rels/workbook.xml.rels': {
          content: `<Relationships>
            <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet3.xml" />
          </Relationships>`,
        },
        'xl/chartsheets/_rels/sheet3.xml.rels': {
          content: `<Relationships>
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing3.xml" />
          </Relationships>`,
        },
        'xl/drawings/_rels/drawing3.xml.rels': {
          content: `<Relationships>
            <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart3.xml" />
          </Relationships>`,
        },
        'xl/charts/chart3.xml': {
          content: `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
            <c:chart>
              <c:title><c:tx><c:rich><a:p><a:r><a:t>Standalone Chart</a:t></a:r></a:p></c:rich></c:tx></c:title>
              <c:plotArea>
                <c:lineChart>
                  <c:ser>
                    <c:tx><c:v>Revenue</c:v></c:tx>
                    <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt></c:strCache></c:strRef></c:cat>
                    <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>42</c:v></c:pt></c:numCache></c:numRef></c:val>
                  </c:ser>
                </c:lineChart>
              </c:plotArea>
            </c:chart>
          </c:chartSpace>`,
        },
      },
      ['Standalone Chart']
    );

    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({
      title: 'Standalone Chart',
      kind: 'line',
      sheetName: 'Standalone Chart',
      categories: ['Q1'],
    });
  });
});
