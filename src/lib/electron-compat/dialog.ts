import {desktop} from "../electron-bridge";
export async function open(options?:Record<string,unknown>):Promise<string|string[]|null> {
  return desktop().openDialog(options);
}
