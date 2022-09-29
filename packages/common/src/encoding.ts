// Pasted with modifications from: https://raw.githubusercontent.com/anonyco/FastestSmallestTextEncoderDecoder/master/EncoderDecoderTogether.src.js
/* eslint no-fallthrough: 0 */

const fromCharCode = String.fromCharCode;
const encoderRegexp = /[\x80-\uD7ff\uDC00-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]?/g;
const tmpBufferU16 = new Uint16Array(32);

export class TextDecoder {
  decode(inputArrayOrBuffer: Uint8Array | ArrayBuffer | SharedArrayBuffer): string {
    const inputAs8 = inputArrayOrBuffer instanceof Uint8Array ? inputArrayOrBuffer : new Uint8Array(inputArrayOrBuffer);

    let resultingString = '',
      tmpStr = '',
      index = 0,
      nextEnd = 0,
      cp0 = 0,
      codePoint = 0,
      minBits = 0,
      cp1 = 0,
      pos = 0,
      tmp = -1;
    const len = inputAs8.length | 0;
    const lenMinus32 = (len - 32) | 0;
    // Note that tmp represents the 2nd half of a surrogate pair incase a surrogate gets divided between blocks
    for (; index < len; ) {
      nextEnd = index <= lenMinus32 ? 32 : (len - index) | 0;
      for (; pos < nextEnd; index = (index + 1) | 0, pos = (pos + 1) | 0) {
        cp0 = inputAs8[index] & 0xff;
        switch (cp0 >> 4) {
          case 15:
            cp1 = inputAs8[(index = (index + 1) | 0)] & 0xff;
            if (cp1 >> 6 !== 0b10 || 0b11110111 < cp0) {
              index = (index - 1) | 0;
              break;
            }
            codePoint = ((cp0 & 0b111) << 6) | (cp1 & 0b00111111);
            minBits = 5; // 20 ensures it never passes -> all invalid replacements
            cp0 = 0x100; //  keep track of th bit size
          case 14:
            cp1 = inputAs8[(index = (index + 1) | 0)] & 0xff;
            codePoint <<= 6;
            codePoint |= ((cp0 & 0b1111) << 6) | (cp1 & 0b00111111);
            minBits = cp1 >> 6 === 0b10 ? (minBits + 4) | 0 : 24; // 24 ensures it never passes -> all invalid replacements
            cp0 = (cp0 + 0x100) & 0x300; // keep track of th bit size
          case 13:
          case 12:
            cp1 = inputAs8[(index = (index + 1) | 0)] & 0xff;
            codePoint <<= 6;
            codePoint |= ((cp0 & 0b11111) << 6) | (cp1 & 0b00111111);
            minBits = (minBits + 7) | 0;

            // Now, process the code point
            if (index < len && cp1 >> 6 === 0b10 && codePoint >> minBits && codePoint < 0x110000) {
              cp0 = codePoint;
              codePoint = (codePoint - 0x10000) | 0;
              if (0 <= codePoint /*0xffff < codePoint*/) {
                // BMP code point
                //nextEnd = nextEnd - 1|0;

                tmp = ((codePoint >> 10) + 0xd800) | 0; // highSurrogate
                cp0 = ((codePoint & 0x3ff) + 0xdc00) | 0; // lowSurrogate (will be inserted later in the switch-statement)

                if (pos < 31) {
                  // notice 31 instead of 32
                  tmpBufferU16[pos] = tmp;
                  pos = (pos + 1) | 0;
                  tmp = -1;
                } else {
                  // else, we are at the end of the inputAs8 and let tmp0 be filled in later on
                  // NOTE that cp1 is being used as a temporary variable for the swapping of tmp with cp0
                  cp1 = tmp;
                  tmp = cp0;
                  cp0 = cp1;
                }
              } else nextEnd = (nextEnd + 1) | 0; // because we are advancing i without advancing pos
            } else {
              // invalid code point means replacing the whole thing with null replacement characters
              cp0 >>= 8;
              index = (index - cp0 - 1) | 0; // reset index  back to what it was before
              cp0 = 0xfffd;
            }

            // Finally, reset the variables for the next go-around
            minBits = 0;
            codePoint = 0;
            nextEnd = index <= lenMinus32 ? 32 : (len - index) | 0;
          /*case 11:
        case 10:
        case 9:
        case 8:
          codePoint ? codePoint = 0 : cp0 = 0xfffd; // fill with invalid replacement character
        case 7:
        case 6:
        case 5:
        case 4:
        case 3:
        case 2:
        case 1:
        case 0:
          tmpBufferU16[pos] = cp0;
          continue;*/
          default: // fill with invalid replacement character
            tmpBufferU16[pos] = cp0;
            continue;
          case 11:
          case 10:
          case 9:
          case 8:
        }
        tmpBufferU16[pos] = 0xfffd; // fill with invalid replacement character
      }
      tmpStr += fromCharCode(
        tmpBufferU16[0],
        tmpBufferU16[1],
        tmpBufferU16[2],
        tmpBufferU16[3],
        tmpBufferU16[4],
        tmpBufferU16[5],
        tmpBufferU16[6],
        tmpBufferU16[7],
        tmpBufferU16[8],
        tmpBufferU16[9],
        tmpBufferU16[10],
        tmpBufferU16[11],
        tmpBufferU16[12],
        tmpBufferU16[13],
        tmpBufferU16[14],
        tmpBufferU16[15],
        tmpBufferU16[16],
        tmpBufferU16[17],
        tmpBufferU16[18],
        tmpBufferU16[19],
        tmpBufferU16[20],
        tmpBufferU16[21],
        tmpBufferU16[22],
        tmpBufferU16[23],
        tmpBufferU16[24],
        tmpBufferU16[25],
        tmpBufferU16[26],
        tmpBufferU16[27],
        tmpBufferU16[28],
        tmpBufferU16[29],
        tmpBufferU16[30],
        tmpBufferU16[31]
      );
      if (pos < 32) tmpStr = tmpStr.slice(0, (pos - 32) | 0); //-(32-pos));
      if (index < len) {
        //fromCharCode.apply(0, tmpBufferU16 : Uint8Array ?  tmpBufferU16.subarray(0,pos) : tmpBufferU16.slice(0,pos));
        tmpBufferU16[0] = tmp;
        pos = ~tmp >>> 31; //tmp !== -1 ? 1 : 0;
        tmp = -1;

        if (tmpStr.length < resultingString.length) continue;
      } else if (tmp !== -1) {
        tmpStr += fromCharCode(tmp);
      }

      resultingString += tmpStr;
      tmpStr = '';
    }

    return resultingString;
  }
}

//////////////////////////////////////////////////////////////////////////////////////
function encoderReplacer(nonAsciiChars: string) {
  // make the UTF string into a binary UTF-8 encoded string
  let point = nonAsciiChars.charCodeAt(0) | 0;
  if (0xd800 <= point) {
    if (point <= 0xdbff) {
      const nextcode = nonAsciiChars.charCodeAt(1) | 0; // defaults to 0 when NaN, causing null replacement character

      if (0xdc00 <= nextcode && nextcode <= 0xdfff) {
        //point = ((point - 0xD800)<<10) + nextcode - 0xDC00 + 0x10000|0;
        point = ((point << 10) + nextcode - 0x35fdc00) | 0;
        if (point > 0xffff)
          return fromCharCode(
            (0x1e /*0b11110*/ << 3) | (point >> 18),
            (0x2 /*0b10*/ << 6) | ((point >> 12) & 0x3f) /*0b00111111*/,
            (0x2 /*0b10*/ << 6) | ((point >> 6) & 0x3f) /*0b00111111*/,
            (0x2 /*0b10*/ << 6) | (point & 0x3f) /*0b00111111*/
          );
      } else point = 65533 /*0b1111111111111101*/; //return '\xEF\xBF\xBD';//fromCharCode(0xef, 0xbf, 0xbd);
    } else if (point <= 0xdfff) {
      point = 65533 /*0b1111111111111101*/; //return '\xEF\xBF\xBD';//fromCharCode(0xef, 0xbf, 0xbd);
    }
  }
  /*if (point <= 0x007f) return nonAsciiChars;
  else */ if (point <= 0x07ff) {
    return fromCharCode((0x6 << 5) | (point >> 6), (0x2 << 6) | (point & 0x3f));
  } else
    return fromCharCode(
      (0xe /*0b1110*/ << 4) | (point >> 12),
      (0x2 /*0b10*/ << 6) | ((point >> 6) & 0x3f) /*0b00111111*/,
      (0x2 /*0b10*/ << 6) | (point & 0x3f) /*0b00111111*/
    );
}

export class TextEncoder {
  public encode(inputString: string): Uint8Array {
    // 0xc0 => 0b11000000; 0xff => 0b11111111; 0xc0-0xff => 0b11xxxxxx
    // 0x80 => 0b10000000; 0xbf => 0b10111111; 0x80-0xbf => 0b10xxxxxx
    const encodedString = inputString === void 0 ? '' : '' + inputString,
      len = encodedString.length | 0;
    let result = new Uint8Array(((len << 1) + 8) | 0);
    let tmpResult: Uint8Array;
    let i = 0,
      pos = 0,
      point = 0,
      nextcode = 0;
    let upgradededArraySize = !Uint8Array; // normal arrays are auto-expanding
    for (i = 0; i < len; i = (i + 1) | 0, pos = (pos + 1) | 0) {
      point = encodedString.charCodeAt(i) | 0;
      if (point <= 0x007f) {
        result[pos] = point;
      } else if (point <= 0x07ff) {
        result[pos] = (0x6 << 5) | (point >> 6);
        result[(pos = (pos + 1) | 0)] = (0x2 << 6) | (point & 0x3f);
      } else {
        widenCheck: {
          if (0xd800 <= point) {
            if (point <= 0xdbff) {
              nextcode = encodedString.charCodeAt((i = (i + 1) | 0)) | 0; // defaults to 0 when NaN, causing null replacement character

              if (0xdc00 <= nextcode && nextcode <= 0xdfff) {
                //point = ((point - 0xD800)<<10) + nextcode - 0xDC00 + 0x10000|0;
                point = ((point << 10) + nextcode - 0x35fdc00) | 0;
                if (point > 0xffff) {
                  result[pos] = (0x1e /*0b11110*/ << 3) | (point >> 18);
                  result[(pos = (pos + 1) | 0)] = (0x2 /*0b10*/ << 6) | ((point >> 12) & 0x3f) /*0b00111111*/;
                  result[(pos = (pos + 1) | 0)] = (0x2 /*0b10*/ << 6) | ((point >> 6) & 0x3f) /*0b00111111*/;
                  result[(pos = (pos + 1) | 0)] = (0x2 /*0b10*/ << 6) | (point & 0x3f) /*0b00111111*/;
                  continue;
                }
                break widenCheck;
              }
              point = 65533 /*0b1111111111111101*/; //return '\xEF\xBF\xBD';//fromCharCode(0xef, 0xbf, 0xbd);
            } else if (point <= 0xdfff) {
              point = 65533 /*0b1111111111111101*/; //return '\xEF\xBF\xBD';//fromCharCode(0xef, 0xbf, 0xbd);
            }
          }
          if (!upgradededArraySize && i << 1 < pos && i << 1 < ((pos - 7) | 0)) {
            upgradededArraySize = true;
            tmpResult = new Uint8Array(len * 3);
            tmpResult.set(result);
            result = tmpResult;
          }
        }
        result[pos] = (0xe /*0b1110*/ << 4) | (point >> 12);
        result[(pos = (pos + 1) | 0)] = (0x2 /*0b10*/ << 6) | ((point >> 6) & 0x3f) /*0b00111111*/;
        result[(pos = (pos + 1) | 0)] = (0x2 /*0b10*/ << 6) | (point & 0x3f) /*0b00111111*/;
      }
    }
    return Uint8Array ? result.subarray(0, pos) : result.slice(0, pos);
  }

  public encodeInto(inputString: string, u8Arr: Uint8Array): { written: number; read: number } {
    const encodedString = inputString === void 0 ? '' : ('' + inputString).replace(encoderRegexp, encoderReplacer);
    let len = encodedString.length | 0,
      i = 0,
      char = 0,
      read = 0;
    const u8ArrLen = u8Arr.length | 0;
    const inputLength = inputString.length | 0;
    if (u8ArrLen < len) len = u8ArrLen;
    putChars: {
      for (; i < len; i = (i + 1) | 0) {
        char = encodedString.charCodeAt(i) | 0;
        switch (char >> 4) {
          case 0:
          case 1:
          case 2:
          case 3:
          case 4:
          case 5:
          case 6:
          case 7:
            read = (read + 1) | 0;
          // extension points:
          case 8:
          case 9:
          case 10:
          case 11:
            break;
          case 12:
          case 13:
            if (((i + 1) | 0) < u8ArrLen) {
              read = (read + 1) | 0;
              break;
            }
          case 14:
            if (((i + 2) | 0) < u8ArrLen) {
              //if (!(char === 0xEF && encodedString.substr(i+1|0,2) === "\xBF\xBD"))
              read = (read + 1) | 0;
              break;
            }
          case 15:
            if (((i + 3) | 0) < u8ArrLen) {
              read = (read + 1) | 0;
              break;
            }
          default:
            break putChars;
        }
        //read = read + ((char >> 6) !== 2) |0;
        u8Arr[i] = char;
      }
    }
    return { written: i, read: inputLength < read ? inputLength : read };
  }
}

/**
 * Encode a UTF-8 string into a Uint8Array
 */
export function encode(s: string): Uint8Array {
  return TextEncoder.prototype.encode(s);
}

/**
 * Decode a Uint8Array into a UTF-8 string
 */
export function decode(a: Uint8Array): string {
  return TextDecoder.prototype.decode(a);
}
