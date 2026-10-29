/**
 * Repackage verified, project-owned native Linux helpers from the v0.1.3
 * official release. No external build tools are needed on the user's host.
 * The release archive is pinned by SHA-256, and the staging step refuses
 * zero-byte placeholders or incorrect architectures.
 */
import { createHash } from "node:crypto";
import { existsSync, createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, chmod, readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
const project = resolve(dirname(fileURLToPath(import.meta.url)),"..");
const helpers = ["liney-media","liney-audio","liney-screen","liney-screen-wayland","liney-screen-x11"];
const platforms = {
  x64: {
    sha256:"59c54186bf58c655918e624de19956d4c483032f59432a1a2e4bd9fc25b1a834",
    asset:"Liney-0.1.3-linux-x86_64.tar.gz",
    expectedArch:62,
  }
};
const cfg=platforms[process.arch];
if(process.platform!=="linux"||!cfg)throw new Error("Native helper staging currently supports Linux x86_64 only");
const cache = process.env.LINEY_RELEASE_ARCHIVE || join(project,".cache","electron-native",cfg.asset);
const release = "https://github.com/Cytech-Team/Liney/releases/download/v0.1.3/"+cfg.asset;
await mkdir(dirname(cache),{recursive:true,mode:0o700});
async function sha256(filename){
 const hasher=createHash("sha256");
 for await(const block of createReadStream(filename))hasher.update(block);
 return hasher.digest("hex");
}
if(!existsSync(cache)){
 console.log("Fetching pinned, official Liney 0.1.3 native-helper archive");
 const response=await fetch(release,{redirect:"follow"});
 if(!response.ok || !response.body)throw new Error("Release download failed: HTTP "+response.status);
 const temp=cache+".tmp-"+process.pid;
 try{
  await pipeline(Readable.fromWeb(response.body),createWriteStream(temp,{flags:"wx",mode:0o600}));
  await rename(temp,cache);
 }catch(error){await rm(temp,{force:true});throw error;}
}
const actual=await sha256(cache);
if(actual!==cfg.sha256)throw new Error("Native helper release checksum mismatch. Refusing unverified archive.");
const destination=join(project,"electron","native");
await mkdir(destination,{recursive:true,mode:0o700});
const prefix=cfg.asset.replace(/\.tar\.gz$/,"");
const extracted=execFileSync("tar",["tzf",cache],{encoding:"utf8",maxBuffer:10*1024*1024}).trim().split("\n");
for(const name of helpers){
 const entry=prefix+"/"+name;
 if(!extracted.includes(entry))throw new Error("Missing helper in trusted archive: "+name);
}
// Extract only explicitly allowlisted executable paths.
execFileSync("tar",["-xzf",cache,"-C",destination,"--strip-components=1",...helpers.map(n=>prefix+"/"+n)],{stdio:"inherit"});
for(const name of helpers){
 const file=join(destination,name);
 const data=await readFile(file);
 if(data.length<100000 || data[0]!==0x7f || data.toString("ascii",1,4)!=="ELF")throw new Error("Invalid ELF helper: "+name);
 const machine=data.readUInt16LE(18);
 if(machine!==cfg.expectedArch)throw new Error("Wrong architecture for "+name);
 await chmod(file,0o755);
 console.log(name, (await stat(file)).size+" bytes",createHash("sha256").update(data).digest("hex").slice(0,16));
}
console.log("Native helpers staged and SHA-256 verified");
