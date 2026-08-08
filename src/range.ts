import parseRange from "range-parser";

export type ParsedRange = { offset: number; length: number } | { suffix: number };

export function rangeHasLength(
  object: ParsedRange
): object is { offset: number; length: number } {
  return (<{ offset: number; length: number }>object).length !== undefined;
}

export function hasSuffix(range: ParsedRange): range is { suffix: number } {
  return (<{ suffix: number }>range).suffix !== undefined;
}

export function getRangeHeader(range: ParsedRange, fileSize: number): string {
  return `bytes ${hasSuffix(range) ? fileSize - range.suffix : range.offset}-${
    hasSuffix(range) ? fileSize - 1 : range.offset + range.length - 1
  }/${fileSize}`;
}

/**
 * Parses a `range` header against a known file size.
 * Returns `undefined` if there is no range header, or `"unsatisfiable"` if the
 * header is present but invalid / not representable as a single R2 range.
 */
export function parseRangeHeader(
  fileSize: number,
  rangeHeader: string | null
): ParsedRange | undefined | "unsatisfiable" {
  if (!rangeHeader) return undefined;

  const parsedRanges = parseRange(fileSize, rangeHeader);
  // R2 only supports 1 range at the moment, reject if there is more than one
  if (
    parsedRanges === -1 ||
    parsedRanges === -2 ||
    parsedRanges.length !== 1 ||
    parsedRanges.type !== "bytes"
  ) {
    return "unsatisfiable";
  }

  const firstRange = parsedRanges[0];
  return fileSize === firstRange.end + 1
    ? { suffix: fileSize - firstRange.start }
    : {
        offset: firstRange.start,
        length: firstRange.end - firstRange.start + 1,
      };
}
