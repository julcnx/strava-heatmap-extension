// Strava's real, non-monotonic "gray" palette, sampled from the public tile:
// https://heatmap-external-a.strava.com/tiles/all/gray/11/1615/1015.png
// Recolor the supplied hot PNGs without changing their indexed heat levels.
// This reproduces the live/test mismatch without account access or networking.
const GRAY =
  'x9Wkx9Wjx9Sjx9Oix9OhyNKgyNKgyNGfyNCeyNCeyM+dyc6cyc6cyc2bycyaycyaycuZysqZysqYysmXysiXy8iWy8eWy8aVy8aVzMWUzMSUzMOTzMOTzMKSzcGSzcGSzcCRzr+Rzr6Qzr6Qzr2Qz7yPz7uPz7uPz7qO0LmO0LiO0LiN0LeN0baN0bWN0bWM0bSM0rOM0rKM0rGM0rGM07CL06+L066L066L1K2L1KyL1KuL1KqL1KqL1amL1aiL1aeL1aeL1aaL1aWL1qSL1qSL1qOL1qKL1qGL1qCL16CL15+M156M152M152M15yM15uM15qN15qN15mN15iN15eO15eO15aO15WO15SP15SP15OP15KQ15KQ15GQ15CR14+R14+R146S142S142S1oyT1ouT1ouU1oqU1omU1omV1YiV1YeW1YeW1YaW1IaX1IWX1ISY1ISY04OZ04KZ04Ka0oGa0oGb0oCb0YCc0X+c0H6d0H6dz32ez32ez3yfznyfznugzXugzXqhzHqhy3miy3miynijynijyXekyXekyHalx3alx3WlxnWmxXWmxXSnxHSnw3OownOownOpwXKpwHKqv3Kqv3GrvnGrvXCrvHCsu3Csum+tum+tuW+uuG+ut26utm6vtW6vtG2vs22wsm2wsW2wsGyxr2yxrmyxrWyyrGuyq2uyqmuzqWuzqGuzp2qzpmq0pWq0pGq0o2q0omq0oWm0oGm1nmm1nWm1nGm1m2m1mmm1mWm1mGm1lmi2lWi2lGi2k2i2kmi2kWi2j2i2jmi2jWi2jGi1i2i1iWi1iGi1h2i1hmi1hGi1g2i1gme0gWe0gGe0fme0fWe0fGeze2ezeWezeGezd2eydmeydGeyc2ixcmixcWiwb2iwbmiwbWivbGiva2iuaWiuaGitZ2itZmisZGisY2irYmirYWiqYGiqXmipXWioXGioW2inWmimWWimV2ilVmikVWikVGijU2iiUmihUWihUGmgTmmfTWmeTGmdS2md';

export const grayPalette = Uint8Array.from(atob(GRAY), (char) => char.charCodeAt(0));

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function recolorGrayPNG(bytes) {
  bytes = new Uint8Array(bytes).slice();
  const view = new DataView(bytes.buffer);
  for (let offset = 8; offset < bytes.length; ) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'PLTE') {
      if (length !== grayPalette.length)
        throw new Error('Unexpected fixture palette size.');
      bytes.set(grayPalette, offset + 8);
      view.setUint32(
        offset + 8 + length,
        crc32(bytes.subarray(offset + 4, offset + 8 + length))
      );
      return bytes;
    }
    offset += length + 12;
  }
  throw new Error('Missing fixture palette.');
}
