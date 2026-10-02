// Minimal, strict parser for single-primary-HDU 2D FITS images.
// Spec references: FITS Standard v4.0.
//   - header is a sequence of 2880-byte blocks made of 80-byte cards
//   - cards are ASCII padded with spaces; the END card terminates the header
//   - string values are single-quoted; a slash outside quotes starts a comment
//   - pixel data is big-endian, starts at the first 2880 boundary after END
// Pixel coordinate convention follows FITS/WCS: 1-based pixel numbers; array
// element j (0-based) is centered at pixel coordinate j+1.
import { fail } from './errors.js';
import { TanWcs } from './wcs.js';

export const BLOCK = 2880;
export const CARD = 80;

const SIMPLE_INT = /^[+-]?\d+$/;
const SIMPLE_FLOAT = /^[+-]?(\d+\.\d*|\.\d+|\d+)([eEdD][+-]?\d+)?$/;

// Parse one 80-byte card. Returns one of:
//   { kind: 'end' }
//   { kind: 'blank' }
//   { kind: 'comment', text }          // COMMENT / HISTORY free-form
//   { kind: 'keyword', name, value, raw, comment }
// Quotes and comment slashes are handled per FITS rules; a single quote inside
// a string is escaped by doubling it.
export function parseCard(card80) {
  if (card80.length !== CARD) throw fail('MALFORMED_HEADER', '卡片长度不是 80 字节');
  const keyPart = card80.slice(0, 8).trimEnd();

  if (keyPart === 'END') {
    // Anything other than spaces after END is technically non-standard; be lenient.
    return { kind: 'end' };
  }
  if (keyPart === '' && card80.trim() === '') return { kind: 'blank' };
  if (keyPart === 'COMMENT' || keyPart === 'HISTORY' ||
      (keyPart === '' && card80.slice(8).trim() !== '')) {
    return { kind: 'comment', name: keyPart || 'COMMENT', text: card80.slice(8).trim() };
  }
  // Standard FITS keywords: uppercase letters, digits, hyphen, underscore.
  if (!/^[A-Z0-9_-]+$/.test(keyPart)) {
    throw fail('MALFORMED_HEADER', `无法识别的关键字格式: "${keyPart}"`);
  }
  if (card80[8] !== '=' ) {
    // Continuation / free-form comment without value indicator.
    return { kind: 'comment', name: keyPart, text: card80.slice(8).trim() };
  }
  // Value/comment occupy columns 10..79 (0-based 9..79).
  let i = 10;
  const rest = card80.slice(10);
  let value = null;
  let stringValue = false;

  const skipSpaces = () => { while (i < CARD && card80[i] === ' ') i++; };
  skipSpaces();

  if (card80[i] === "'") {
    // Quoted string: find closing quote, respecting doubled '' escaping.
    stringValue = true;
    let out = '';
    i += 1;
    let closed = false;
    while (i < CARD) {
      if (card80[i] === "'") {
        if (card80[i + 1] === "'") { out += "'"; i += 2; continue; }
        closed = true; i += 1; break;
      }
      out += card80[i];
      i += 1;
    }
    if (!closed) throw fail('MALFORMED_HEADER', `关键字 ${keyPart} 的字符串引号未闭合`);
    // FITS: leading spaces inside the string are significant, trailing spaces
    // are not — strip trailing spaces only.
    out = out.replace(/ +$/, '');
    // After a string, only spaces and an optional /comment are legal.
    while (i < CARD && card80[i] === ' ') i++;
    if (i < CARD && card80[i] !== '/') {
      throw fail('MALFORMED_HEADER', `关键字 ${keyPart} 字符串值后存在非法字符`);
    }
    value = out;
  } else {
    // Unquoted: read until a slash that begins a comment.
    let token = '';
    while (i < CARD) {
      const ch = card80[i];
      if (ch === '/') break;
      token += ch;
      i += 1;
    }
    token = token.trim();
    if (token === '') throw fail('MALFORMED_HEADER', `关键字 ${keyPart} 缺少值`);
    value = convertScalar(token, keyPart);
  }

  let comment = null;
  if (i < CARD && card80[i] === '/') {
    comment = card80.slice(i + 1).trim();
  } else if (!stringValue) {
    while (i < CARD && card80[i] === ' ') i++;
    if (i < CARD && card80[i] !== '/') {
      throw fail('MALFORMED_HEADER', `关键字 ${keyPart} 的值尾部存在非法字符`);
    }
    if (i < CARD) comment = card80.slice(i + 1).trim();
  }
  return { kind: 'keyword', name: keyPart.toUpperCase(), value, raw: rest, comment };
}

function convertScalar(token, keyPart) {
  if (token === 'T') return true;
  if (token === 'F') return false;
  // FITS complex values [re, im] are not used here.
  if (token.startsWith('(')) throw fail('MALFORMED_HEADER', `关键字 ${keyPart} 使用了不支持的复数值`);
  if (SIMPLE_INT.test(token)) return parseInt(token, 10);
  const f = token.replace(/[dD]/, 'e');
  if (SIMPLE_FLOAT.test(token)) return parseFloat(f);
  // Bareword tokens are non-standard; flag rather than guess.
  throw fail('MALFORMED_HEADER', `关键字 ${keyPart} 的值无法解析: "${token}"`);
}

// Walk all 2880-byte header blocks until an END card.
// Returns { cards, dataOffset, totalHeaderBytes, hadPaddingIssue }
export function parseHeaderBlocks(buffer) {
  const text = buffer.toString('latin1');
  if (buffer.length < BLOCK) {
    throw fail('MALFORMED_HEADER', `文件不足 2880 字节（实际 ${buffer.length}），没有完整头块`);
  }
  const cards = [];
  let offset = 0;
  let endFound = false;
  while (offset + BLOCK <= buffer.length) {
    for (let c = 0; c < BLOCK; c += CARD) {
      const card = text.slice(offset + c, offset + c + CARD);
      const parsed = parseCard(card);
      if (parsed.kind === 'end') { endFound = true; break; }
      // Keep keyword cards plus COMMENT/HISTORY text cards; blanks are dropped.
      if (parsed.kind === 'keyword' || parsed.kind === 'comment') cards.push(parsed);
    }
    offset += BLOCK;
    if (endFound) break;
    if (offset >= 36 * BLOCK) {
      throw fail('MALFORMED_HEADER', '头块超过 36 个仍未遇到 END，疑似畸形文件');
    }
  }
  if (!endFound) throw fail('MALFORMED_HEADER', '2880 字节头块序列中未找到 END 卡片');
  return { cards, dataOffset: offset, totalHeaderBytes: offset };
}

// Build a keyword -> value map (first occurrence wins per FITS convention).
export function cardsToMap(cards) {
  const map = new Map();
  const comments = new Map();
  for (const c of cards) {
    if (c.kind !== 'keyword') continue;
    if (!map.has(c.name)) {
      map.set(c.name, c.value);
      if (c.comment) comments.set(c.name, c.comment);
    }
  }
  return { map, comments };
}

function num(map, key) {
  if (!map.has(key)) return undefined;
  const v = map.get(key);
  return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
}

// Parse the whole primary HDU and produce a validated image descriptor:
// { header:{...}, width, height, bitpix, data:Buffer, bscale, bzero, blank,
//   wcs:{ crpix:[x,y], crval:[ra,dec], cd:[[a,b],[c,d]] } }
export function parsePrimaryImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw fail('EMPTY_UPLOAD', '上传内容为空');
  const { cards, dataOffset } = parseHeaderBlocks(buffer);
  const { map } = cardsToMap(cards);

  if (map.get('SIMPLE') !== true) {
    throw fail('NOT_PRIMARY_IMAGE', '主 HDU 的 SIMPLE 关键字不为 T，不是标准 FITS 主图像');
  }
  const bitpix = map.get('BITPIX');
  if (![16, -32].includes(bitpix)) {
    throw fail('UNSUPPORTED_BITPIX', `仅支持 BITPIX=16 或 -32，文件为 BITPIX=${bitpix}`);
  }
  const naxis = map.get('NAXIS');
  if (naxis !== 2) {
    throw fail(naxis === 0 ? 'NOT_PRIMARY_IMAGE' : 'UNSUPPORTED_NAXIS',
      `仅支持 NAXIS=2 的二维图像，文件为 NAXIS=${naxis}`);
  }
  const width = map.get('NAXIS1');
  const height = map.get('NAXIS2');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw fail('MALFORMED_HEADER', `NAXIS1/NAXIS2 必须为正整数，得到 ${width} x ${height}`);
  }
  if (!Number.isSafeInteger(width * height) || width > 0x7fffffff || height > 0x7fffffff) {
    throw fail('DIMENSION_PRODUCT_OVERFLOW', `声明尺寸 ${width} x ${height} 乘积溢出，拒绝分配`);
  }
  const bytesPerPixel = bitpix === 16 ? 2 : 4;
  const dataBytes = width * height * bytesPerPixel;
  if (!Number.isSafeInteger(dataBytes) || dataBytes > buffer.length - dataOffset) {
    throw fail('TRUNCATED_DATA',
      `头声明像素数据 ${dataBytes} 字节，文件在数据起点后仅有 ${Math.max(0, buffer.length - dataOffset)} 字节`);
  }

  const bscale = num(map, 'BSCALE');
  const bzero = num(map, 'BZERO');
  const blank = map.has('BLANK') ? map.get('BLANK') : undefined;
  if (map.has('BLANK') && bitpix !== 16) {
    throw fail('MALFORMED_HEADER', 'BLANK 只允许出现在整型图像中');
  }
  if (map.has('BLANK') && !Number.isInteger(blank)) {
    throw fail('MALFORMED_HEADER', 'BLANK 必须为整数');
  }

  const wcsSpec = readWcs(map);
  const data = buffer.subarray(dataOffset, dataOffset + dataBytes);
  // Attach a ready-to-use TAN WCS object (also re-validates invertibility so a
  // singular CD is rejected at upload time with a specific error).
  const wcs = new TanWcs(wcsSpec, width, height);
  return {
    width, height, bitpix, data,
    bscale: Number.isFinite(bscale) ? bscale : 1,
    bzero: Number.isFinite(bzero) ? bzero : 0,
    blank: Number.isInteger(blank) ? blank : null,
    wcs
  };
}

function readWcs(map) {
  // Explicitly detect the legacy CDELT + PC rotation convention so we never
  // silently export wrong coordinates for such files.
  const hasCd = map.has('CD1_1') || map.has('CD1_2') || map.has('CD2_1') || map.has('CD2_2');
  const hasCdelt = map.has('CDELT1') || map.has('CDELT2');
  const hasPc = map.has('PC1_1') || map.has('PC1_2') || map.has('PC2_1') || map.has('PC2_2');
  if ((hasCdelt || hasPc) && !hasCd) {
    const parts = [];
    if (hasCdelt) parts.push('CDELTn');
    if (hasPc) parts.push('PCi_j');
    throw fail('UNSUPPORTED_WCS_CONVENTION',
      `检测到 ${parts.join(' + ')} 形式的 WCS（CDELT 加 PC 矩阵），本工作台仅支持 CD 矩阵；为避免按错误坐标导出，已拒绝该文件`);
  }

  const required = ['CRPIX1', 'CRPIX2', 'CRVAL1', 'CRVAL2',
                    'CD1_1', 'CD1_2', 'CD2_1', 'CD2_2'];
  for (const k of required) {
    if (!map.has(k)) {
      throw fail('MISSING_WCS', `缺少 WCS 必需关键字 ${k}`);
    }
    const v = map.get(k);
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw fail('INVALID_WCS_VALUE', `WCS 关键字 ${k} 不是有限数值`);
    }
  }
  const ctype1 = (map.get('CTYPE1') || '').toString();
  const ctype2 = (map.get('CTYPE2') || '').toString();
  // CTYPE is exactly 8 characters: 4-char coordinate type, 3-char projection
  // code in columns 6-8, separated by dashes (e.g. 'RA---TAN', 'DEC--TAN').
  const projectionOf = (t) => (t.length === 8 ? t.slice(5, 8) : null);
  if (!ctype1 || !ctype2) {
    throw fail('MISSING_WCS', '缺少 CTYPE1/CTYPE2，无法确认投影类型');
  }
  const p1 = projectionOf(ctype1);
  const p2 = projectionOf(ctype2);
  if (p1 !== 'TAN' || p2 !== 'TAN') {
    throw fail('UNSUPPORTED_PROJECTION',
      `仅支持 TAN 投影（CTYPE 如 RA---TAN/DEC--TAN），文件为 ${ctype1} / ${ctype2}`);
  }
  if (ctype1.slice(0, 4) !== 'RA--' || ctype2.slice(0, 4) !== 'DEC-') {
    throw fail('UNSUPPORTED_PROJECTION',
      `CTYPE 坐标类型不是 RA/DEC 天球坐标: ${ctype1} / ${ctype2}`);
  }

  const crpix = [map.get('CRPIX1'), map.get('CRPIX2')];
  const crval = [map.get('CRVAL1'), map.get('CRVAL2')];
  const cd = [
    [map.get('CD1_1'), map.get('CD1_2')],
    [map.get('CD2_1'), map.get('CD2_2')]
  ];
  if (!(crval[0] >= 0 && crval[0] <= 360)) {
    throw fail('INVALID_WCS_VALUE', `CRVAL1(赤经)=${crval[0]} 超出 [0,360]`);
  }
  if (!(crval[1] >= -90 && crval[1] <= 90)) {
    throw fail('INVALID_WCS_VALUE', `CRVAL2(赤纬)=${crval[1]} 超出 [-90,90]`);
  }
  return { crpix, crval, cd };
}
