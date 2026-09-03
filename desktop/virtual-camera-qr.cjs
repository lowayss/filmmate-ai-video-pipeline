function gfTables() {
  const exp = new Array(512);
  const log = new Array(256);
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    exp[index] = value;
    log[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) exp[index] = exp[index - 255];
  return {exp, log};
}

const GF = gfTables();
function gfMultiply(a, b) { return !a || !b ? 0 : GF.exp[GF.log[a] + GF.log[b]]; }

function rsGenerator(degree) {
  let polynomial = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = new Array(polynomial.length + 1).fill(0);
    for (let position = 0; position < polynomial.length; position += 1) {
      next[position] ^= polynomial[position];
      next[position + 1] ^= gfMultiply(polynomial[position], GF.exp[index]);
    }
    polynomial = next;
  }
  return polynomial;
}

function rsRemainder(data, degree) {
  const generator = rsGenerator(degree);
  const output = [...data, ...new Array(degree).fill(0)];
  for (let index = 0; index < data.length; index += 1) {
    const factor = output[index];
    if (!factor) continue;
    for (let offset = 0; offset < generator.length; offset += 1) output[index + offset] ^= gfMultiply(generator[offset], factor);
  }
  return output.slice(data.length);
}

function pushBits(output, value, length) {
  for (let bit = length - 1; bit >= 0; bit -= 1) output.push((value >>> bit) & 1);
}

function dataCodewords(text) {
  const bytes = [...Buffer.from(String(text), "utf8")];
  if (bytes.length > 78) throw new Error("virtual_camera_qr_payload_too_long");
  const bits = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, 8);
  for (const byte of bytes) pushBits(bits, byte, 8);
  const maxBits = 80 * 8;
  for (let index = 0; index < 4 && bits.length < maxBits; index += 1) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const output = [];
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0;
    for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | bits[index + offset];
    output.push(byte);
  }
  let pad = 0;
  while (output.length < 80) output.push(pad++ % 2 === 0 ? 0xec : 0x11);
  return output;
}

function bchTypeInfo(data) {
  let value = data << 10;
  const generator = 0x537;
  const degree = input => {
    let result = -1;
    let current = input;
    while (current) { result += 1; current >>>= 1; }
    return result;
  };
  while (degree(value) >= degree(generator)) value ^= generator << (degree(value) - degree(generator));
  return ((data << 10) | value) ^ 0x5412;
}

function qrMatrix(text) {
  const size = 33;
  const modules = Array.from({length:size}, () => Array(size).fill(null));
  const set = (row, column, value) => {
    if (row >= 0 && row < size && column >= 0 && column < size) modules[row][column] = Boolean(value);
  };
  const finder = (top, left) => {
    for (let row = -1; row <= 7; row += 1) {
      for (let column = -1; column <= 7; column += 1) {
        const y = top + row, x = left + column;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const black = row >= 0 && row <= 6 && column >= 0 && column <= 6
          && (row === 0 || row === 6 || column === 0 || column === 6 || (row >= 2 && row <= 4 && column >= 2 && column <= 4));
        set(y, x, black);
      }
    }
  };
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);
  for (let index = 8; index < size - 8; index += 1) {
    if (modules[6][index] === null) set(6, index, index % 2 === 0);
    if (modules[index][6] === null) set(index, 6, index % 2 === 0);
  }
  for (let row = -2; row <= 2; row += 1) {
    for (let column = -2; column <= 2; column += 1) set(26 + row, 26 + column, Math.max(Math.abs(row), Math.abs(column)) !== 1);
  }
  const format = bchTypeInfo(1 << 3);
  for (let index = 0; index < 15; index += 1) {
    const value = ((format >> index) & 1) === 1;
    if (index < 6) set(index, 8, value);
    else if (index < 8) set(index + 1, 8, value);
    else set(size - 15 + index, 8, value);
    if (index < 8) set(8, size - index - 1, value);
    else if (index < 9) set(8, 15 - index, value);
    else set(8, 15 - index - 1, value);
  }
  set(size - 8, 8, true);
  const data = dataCodewords(text);
  const all = [...data, ...rsRemainder(data, 20)];
  const bits = [];
  for (const byte of all) pushBits(bits, byte, 8);
  let row = size - 1;
  let direction = -1;
  let bitIndex = 0;
  for (let column = size - 1; column > 0; column -= 2) {
    if (column === 6) column -= 1;
    while (true) {
      for (let offset = 0; offset < 2; offset += 1) {
        const x = column - offset;
        if (modules[row][x] !== null) continue;
        let dark = bitIndex < bits.length ? bits[bitIndex++] : 0;
        if ((row + x) % 2 === 0) dark ^= 1;
        set(row, x, dark);
      }
      row += direction;
      if (row < 0 || row >= size) {
        row -= direction;
        direction = -direction;
        break;
      }
    }
  }
  return modules;
}

function qrSvg(text, {scale = 6, margin = 4} = {}) {
  const modules = qrMatrix(text);
  const moduleCount = modules.length;
  const size = (moduleCount + margin * 2) * scale;
  const rectangles = [];
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (modules[row][column]) rectangles.push(`<rect x="${(column + margin) * scale}" y="${(row + margin) * scale}" width="${scale}" height="${scale}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="100%" height="100%" fill="white"/><g fill="black">${rectangles.join("")}</g></svg>`;
}

function qrDataUrl(text, options) {
  return `data:image/svg+xml;base64,${Buffer.from(qrSvg(text, options), "utf8").toString("base64")}`;
}

module.exports = {qrMatrix, qrSvg, qrDataUrl};
