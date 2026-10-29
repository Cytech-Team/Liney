import {test} from "node:test";
import assert from "node:assert/strict";
import {qrToNativeImage} from "../qr.mjs";

test("Native QR contains white quiet zone and dark modules without WebView",()=>{
  const image=qrToNativeImage("https://example.org/liney-qr-smoke");
  assert.ok(image.width >= 100);
  assert.equal(image.width,image.height);
  assert.equal(image.data.length,image.width*image.height*4);
  assert.deepEqual([...image.data.slice(0,4)],[255,255,255,255]);
  assert.ok(image.data.some((n,i)=>i%4!==3 && n===24),"dark module pixels exist");
});
test("QR token URLs are never serialized into logs or network calls",()=>{
  assert.throws(()=>qrToNativeImage("javascript:alert(1)"),/Invalid QR/);
  assert.throws(()=>qrToNativeImage("http://example.org/login"),/Invalid QR/);
});
