/**
 * Build a QR image fully in memory using Node + Slint.
 * Does not launch a browser, expose a localhost port, or write login tokens.
 */
import QRCode from "qrcode";

export function qrToNativeImage(url, scale=5) {
  if (typeof url !== "string" || !url.startsWith("https://") || url.length > 4096)
    throw Error("Invalid QR login URL");
  const code = QRCode.create(url, {errorCorrectionLevel:"M"});
  const modules = code.modules;
  const quiet=4;
  const dim=(modules.size+quiet*2)*scale;
  const pixels=new Uint8Array(dim*dim*4);
  const rowSize=dim*4;
  // RGBA; white "quiet zone" required for reliable camera detection.
  pixels.fill(255);
  for(let y=0;y<modules.size;y++) for(let x=0;x<modules.size;x++) {
    if (!modules.get(x,y)) continue;
    for(let py=0;py<scale;py++) {
      let p=((y+quiet)*scale+py)*rowSize + (x+quiet)*scale*4;
      for(let px=0;px<scale;px++,p+=4) {
        pixels[p]=24; pixels[p+1]=37; pixels[p+2]=51;pixels[p+3]=255;
      }
    }
  }
  return {width:dim,height:dim,data:pixels};
}
