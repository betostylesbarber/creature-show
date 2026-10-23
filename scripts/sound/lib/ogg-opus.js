// Ogg Opus muxer (RFC 7845) for packets from WebCodecs' AudioEncoder. Plain script: it is
// injected into the headless Chrome tool page (see chrome.mjs) and also importable in Node.
// muxOggOpus({ packets: Uint8Array[], channels, preSkip, totalFrames, frameSize, vendor })
//   -> Uint8Array of a complete .ogg file. totalFrames trims the encoder's end padding.
(function (root) {
  const CRC = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    CRC[i] = r >>> 0;
  }
  function crc32(bytes) {
    let c = 0;
    for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
    return c >>> 0;
  }
  function page({ packets, granule, serial, seq, flags }) {
    const lacing = [];
    for (const p of packets) {
      let n = p.length;
      while (n >= 255) {
        lacing.push(255);
        n -= 255;
      }
      lacing.push(n);
    }
    const body = packets.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(27 + lacing.length + body);
    const dv = new DataView(out.buffer);
    out.set([0x4f, 0x67, 0x67, 0x53], 0);
    out[4] = 0;
    out[5] = flags;
    const g = BigInt(granule);
    dv.setUint32(6, Number(g & 0xffffffffn), true);
    dv.setUint32(10, Number((g >> 32n) & 0xffffffffn), true);
    dv.setUint32(14, serial, true);
    dv.setUint32(18, seq, true);
    dv.setUint32(22, 0, true);
    out[26] = lacing.length;
    out.set(lacing, 27);
    let p = 27 + lacing.length;
    for (const pk of packets) {
      out.set(pk, p);
      p += pk.length;
    }
    dv.setUint32(22, crc32(out), true);
    return out;
  }
  function muxOggOpus({ packets, channels, preSkip = 312, totalFrames, frameSize = 960, vendor = "metoda-sponge sound tools", serial = 0x5eed0001 }) {
    const head = new Uint8Array(19);
    const hv = new DataView(head.buffer);
    head.set([...'OpusHead'].map((c) => c.charCodeAt(0)), 0);
    head[8] = 1;
    head[9] = channels;
    hv.setUint16(10, preSkip, true);
    hv.setUint32(12, 48000, true);
    hv.setInt16(16, 0, true);
    head[18] = 0;
    const v = new TextEncoder().encode(vendor);
    const tags = new Uint8Array(8 + 4 + v.length + 4);
    const tv = new DataView(tags.buffer);
    tags.set([...'OpusTags'].map((c) => c.charCodeAt(0)), 0);
    tv.setUint32(8, v.length, true);
    tags.set(v, 12);
    tv.setUint32(12 + v.length, 0, true);
    const pages = [];
    let seq = 0;
    pages.push(page({ packets: [head], granule: 0, serial, seq: seq++, flags: 0x02 }));
    pages.push(page({ packets: [tags], granule: 0, serial, seq: seq++, flags: 0 }));
    const end = preSkip + totalFrames;
    let granule = 0;
    for (let i = 0; i < packets.length; ) {
      const group = [];
      let segs = 0;
      while (i < packets.length && group.length < 50) {
        const s = Math.floor(packets[i].length / 255) + 1;
        if (segs + s > 255) break;
        group.push(packets[i]);
        segs += s;
        granule += frameSize;
        i++;
      }
      const last = i >= packets.length;
      pages.push(page({ packets: group, granule: last ? end : Math.min(granule, end), serial, seq: seq++, flags: last ? 0x04 : 0 }));
    }
    const size = pages.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(size);
    let o = 0;
    for (const p of pages) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
  root.muxOggOpus = muxOggOpus;
  root.oggCrc32 = crc32;
})(typeof globalThis !== "undefined" ? globalThis : this);
