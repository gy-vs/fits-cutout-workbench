/**
 * FITS (Flexible Image Transport System) primary HDU reader/writer.
 *
 * Scope: 2-D primary images with BITPIX 16 (signed integer) or -32
 * (32-bit float), big-endian on disk. Header cards are exactly 80 bytes,
 * header/data blocks are padded to multiples of 2880 bytes.
 *
 * No external dependencies; works in Node and in the browser.
 */

export const BLOCK = 2880;
export const CARD = 80;

const MAX_NAXIS = 2;

/** Distinguishable protocol-level error with a stable machine code. */
export class FitsError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'FitsError';
    this.code = code;
    this.status = status;
  }
}

/** Parse a single 80-byte header card. Returns null for blank/comment cards. */
export function parseCard(card) {
  if (card.length < CARD) {
    throw new FitsError('MALFORMED_HEADER', `头卡片长度为 ${card.length} 字节，不足 ${CARD} 字节`);
  }
  const keyword = card.slice(0, 8).trimEnd();
  if (keyword === '') return null; // blank card
  if (keyword === 'COMMENT' || keyword === 'HISTORY') {
    return { keyword, value: null, comment: card.slice(8).trim(), raw: card };
  }
  if (card[8] !== '=') {
    // Keyless cards outside COMMENT/HISTORY are not valid FITS, but be lenient:
    // keep the text so callers can inspect it, but do not treat it as a value.
    return { keyword, value: null, comment: card.slice(8).trim(), raw: card, keyless: true };
  }

  const valueIndicator = card.slice(10, 30);
  const rest = card.slice(10);

  // Quoted string value: opening quote must be the first non-space char.
  if (valueIndicator.startsWith("'") || rest.trimStart().startsWith("'")) {
    return parseStringCard(keyword, rest, card);
  }

  // Value ends at the start of a comment slash, but a slash never opens
  // inside quotes here (that case is handled above).
  const slashIdx = findCommentSlash(rest);
  const valueText = (slashIdx === -1 ? rest : rest.slice(0, slashIdx)).trim();
  const comment = slashIdx === -1 ? '' : rest.slice(slashIdx + 1).trim();

  if (valueText === '') {
    return { keyword, value: null, comment, raw: card };
  }
  if (valueText === 'T') return { keyword, value: true, comment, raw: card };
  if (valueText === 'F') return { keyword, value: false, comment, raw: card };

  // Numeric (possibly with leading sign / exponent). FITS allows complex
  // values; reject them explicitly rather than parsing half the text.
  if (valueText.includes(' ')) {
    throw new FitsError(
      'MALFORMED_HEADER',
      `关键字 ${keyword} 的值含异常空格：${JSON.stringify(valueText)}`
    );
  }
  const num = Number(valueText);
  if (Number.isNaN(num)) {
    throw new FitsError(
      'MALFORMED_HEADER',
      `关键字 ${keyword} 的值无法解析：${JSON.stringify(valueText)}`
    );
  }
  return { keyword, value: num, comment, raw: card };
}

/** Parse a card whose value is a quoted string, honouring '' escapes. */
function parseStringCard(keyword, rest, raw) {
  const start = rest.indexOf("'");
  let i = start + 1;
  let out = '';
  let closed = false;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === "'") {
      if (rest[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      closed = true;
      break;
    }
    out += ch;
    i += 1;
  }
  if (!closed) {
    throw new FitsError('MALFORMED_HEADER', `关键字 ${keyword} 的字符串缺少闭合引号`);
  }
  // Everything after the closing quote; a comment starts with / .
  let comment = '';
  const tail = rest.slice(i + 1);
  const slash = tail.indexOf('/');
  if (slash !== -1) comment = tail.slice(slash + 1).trim();
  return { keyword, value: out, comment, raw };
}

/** Find the slash that begins the comment (none inside strings here). */
function findCommentSlash(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "'") {
      // skip the quoted segment
      i++;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
    } else if (text[i] === '/') {
      return i;
    }
  }
  return -1;
}

/**
 * Parse the primary HDU of a FITS byte buffer.
 * Returns { header, cards, bitpix, naxis, width(=NAXIS1), height(=NAXIS2),
 *           bscale, bzero, blank, dataStart, dataBytes, view }.
 */
export function parseFits(buffer) {
  if (!(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer) && !Buffer.isBuffer(buffer)) {
    throw new FitsError('MALFORMED_HEADER', '输入不是字节缓冲区');
  }
  const bytes = Buffer.isBuffer(buffer)
    ? buffer
    : ArrayBuffer.isView(buffer)
      ? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : Buffer.from(buffer);

  if (bytes.length < BLOCK) {
    throw new FitsError('MALFORMED_HEADER', `文件长度 ${bytes.length} 小于一个 FITS 头块（${BLOCK} 字节）`);
  }
  if (bytes.toString('latin1', 0, 8) !== 'SIMPLE  ') {
    throw new FitsError('MALFORMED_HEADER', '缺少 SIMPLE 关键字（不是 FITS 文件）');
  }

  const cards = [];
  const header = Object.create(null);
  let offset = 0;
  let sawEnd = false;
  while (offset + BLOCK <= bytes.length) {
    for (let c = 0; c < BLOCK; c += CARD) {
      const cardText = bytes.toString('latin1', offset + c, offset + c + CARD);
      const parsed = parseCard(cardText);
      if (parsed) {
        cards.push(parsed);
        if (!(parsed.keyword in header)) header[parsed.keyword] = parsed.value;
      }
      if (cardText.startsWith('END' + ' '.repeat(77)) ||
          (cardText.slice(0, 8).trimEnd() === 'END' && cardText[8] !== '=')) {
        sawEnd = true;
      }
    }
    offset += BLOCK;
    if (sawEnd) break;
  }
  if (!sawEnd) {
    throw new FitsError('MALFORMED_HEADER', '头中未找到 END 卡片');
  }

  if (header.SIMPLE !== true) {
    throw new FitsError('MALFORMED_HEADER', 'SIMPLE 必须为 T');
  }

  const bitpix = header.BITPIX;
  if (bitpix !== 16 && bitpix !== -32) {
    throw new FitsError(
      'UNSUPPORTED_BITPIX',
      `仅支持 BITPIX = 16 或 -32，文件为 BITPIX = ${bitpix}`
    );
  }

  const naxis = header.NAXIS;
  if (naxis !== MAX_NAXIS) {
    throw new FitsError('UNSUPPORTED_NAXIS', `仅支持 NAXIS = 2，文件为 NAXIS = ${naxis}`);
  }

  const width = header.NAXIS1;
  const height = header.NAXIS2;
  for (const [name, v] of [['NAXIS1', width], ['NAXIS2', height]]) {
    if (!Number.isInteger(v) || v <= 0) {
      throw new FitsError('MALFORMED_HEADER', `${name} 必须是正整数，实际为 ${v}`);
    }
  }

  // Guard the NAXIS product against pathological dimensions (safe integer range).
  if (!Number.isSafeInteger(width * height)) {
    throw new FitsError(
      'DIMENSION_OVERFLOW',
      `NAXIS1 × NAXIS2 = ${width} × ${height} 超出可安全寻址范围`
    );
  }

  const bytesPerPixel = bitpix === 16 ? 2 : 4;
  const dataBytes = width * height * bytesPerPixel;
  // Data start must be a multiple of 2880 by construction (we consumed whole blocks).
  const dataStart = offset;
  if (dataStart % BLOCK !== 0) {
    throw new FitsError('PADDING_VIOLATION', `数据起始位置 ${dataStart} 未按 ${BLOCK} 字节对齐`);
  }
  if (bytes.length < dataStart + dataBytes) {
    throw new FitsError(
      'TRUNCATED_DATA',
      `像素数据不完整：需要 ${dataBytes} 字节，文件在头块后仅剩 ${bytes.length - dataStart} 字节`
    );
  }

  const bscale = numOr(header.BSCALE, 1);
  const bzero = numOr(header.BZERO, 0);
  const blank = header.BLANK;
  if (bitpix === -32 && blank !== undefined) {
    // BLANK is only meaningful for integers per the standard; ignore it for floats
    // but note it. NaN carries missing float values.
  }

  return {
    buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    cards,
    header,
    bitpix,
    naxis: 2,
    width,
    height,
    bscale,
    bzero,
    blank: Number.isInteger(blank) ? blank : null,
    dataStart,
    dataBytes,
  };
}

function numOr(v, dflt) {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

const rawReader = {
  16: (dv, o) => dv.getInt16(o, false),
  [-32]: (dv, o) => dv.getFloat32(o, false),
};

/** Read a stored (raw, big-endian) pixel; null when out of bounds. */
export function readRaw(image, x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  const bpp = image.bitpix === 16 ? 2 : 4;
  const dv = new DataView(image.buffer, image.dataStart, image.dataBytes);
  return rawReader[image.bitpix](dv, (y * image.width + x) * bpp);
}

/** True when a stored pixel represents missing data (BLANK for ints, NaN for floats). */
export function isMissingRaw(image, raw) {
  if (raw === null) return true;
  if (image.bitpix === 16) return image.blank !== null && raw === image.blank;
  return !Number.isFinite(raw);
}

/** Physical value BSCALE/BZERO applied; null means missing/out of bounds. */
export function readPhysical(image, x, y) {
  const raw = readRaw(image, x, y);
  if (raw === null) return null;
  if (isMissingRaw(image, raw)) return null;
  return raw * image.bscale + image.bzero;
}

/** Raw typed view of the whole stored pixel array (Int16 or Float32, little view). */
export function rawView(image) {
  const dv = new DataView(image.buffer, image.dataStart, image.dataBytes);
  const n = image.width * image.height;
  if (image.bitpix === 16) {
    const arr = new Int16Array(n);
    for (let i = 0; i < n; i++) arr[i] = dv.getInt16(i * 2, false);
    return arr;
  }
  const arr = new Float32Array(n);
  for (let i = 0; i < n; i++) arr[i] = dv.getFloat32(i * 4, false);
  return arr;
}

/* ------------------------------------------------------------------ */
/* Writer                                                              */
/* ------------------------------------------------------------------ */

/** Pad a byte buffer up to a 2880-byte boundary. */
export function pad2880(buf) {
  const rem = buf.length % BLOCK;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(BLOCK - rem, 0x20)]);
}

/** Build an 80-byte card from keyword, value and optional comment. */
export function formatCard(keyword, value, comment = '') {
  if (keyword.length > 8) throw new FitsError('BAD_CARD', `关键字过长：${keyword}`);
  let body;
  if (typeof value === 'boolean') {
    body = `${keyword.padEnd(8)}= ${value ? 'T' : 'F'}`;
  } else if (typeof value === 'number') {
    body = formatNumberCard(keyword, value);
  } else if (typeof value === 'string') {
    let s = value.replace(/'/g, "''");
    if (s.length > 67) s = s.slice(0, 67);
    // FITS strings are quoted and left-justified within 8 chars minimum.
    body = `${keyword.padEnd(8)}= '${s.padEnd(8)}'`;
  } else {
    body = keyword.padEnd(8);
  }
  if (comment) {
    const room = CARD - body.length - 3;
    if (room > 0) body += ' / ' + comment.slice(0, room);
  }
  return body.padEnd(CARD, ' ');
}

function formatNumberCard(keyword, value) {
  const key = keyword.padEnd(8);
  if (Number.isInteger(value) && Number.isSafeInteger(value) && Math.abs(value) < 1e9) {
    return `${key}= ${String(value).padStart(20)}`;
  }
  // %.12g gives plenty of precision for float32 round trips.
  let s;
  if (Number.isInteger(value) && Number.isSafeInteger(value)) {
    s = String(value);
  } else {
    s = value.toPrecision(10).replace(/\.?0+(e|$)/, '$1');
    if (!s.includes('.') && !s.includes('e') && !s.includes('E')) s += '.0';
  }
  if (s.length > 20) s = value.toExponential(13).replace(/\.?0+e/, 'e');
  return `${key}= ${s.padStart(20)}`;
}

/** Assemble a complete single-HDU FITS file from cards + pixel typed array. */
export function writeFits(cardList, pixels, bitpix, width, height) {
  const headerCards = cardList.map((c) =>
    c.length === 80 ? c : formatCard(c[0], c[1], c[2] ?? '')
  );
  const end = 'END'.padEnd(CARD, ' ');
  const headerBuf = Buffer.from(headerCards.concat(end).join(''), 'latin1');
  const header = pad2880(headerBuf);

  const bpp = bitpix === 16 ? 2 : 4;
  const needBytes = width * height * bpp;
  const data = Buffer.alloc(needBytes);
  const dv = new DataView(data.buffer, data.byteOffset, needBytes);
  if (bitpix === 16) {
    if (!(pixels instanceof Int16Array)) {
      throw new FitsError('BAD_CARD', 'BITPIX 16 需要 Int16Array 原始像素');
    }
    for (let i = 0; i < pixels.length; i++) dv.setInt16(i * 2, pixels[i], false);
  } else {
    if (!(pixels instanceof Float32Array)) {
      throw new FitsError('BAD_CARD', 'BITPIX -32 需要 Float32Array 原始像素');
    }
    for (let i = 0; i < pixels.length; i++) dv.setFloat32(i * 4, pixels[i], false);
  }
  const dataBlock = pad2880(data);
  return Buffer.concat([header, dataBlock]);
}
