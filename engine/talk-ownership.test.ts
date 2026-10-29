import {describe, expect, test} from "bun:test";
import {reconcileTalkOwnership, resolveTalkOwnership} from "./talk-ownership";

const me="u"+"a".repeat(32);
const them="u"+"b".repeat(32);

describe("talk message ownership",()=>{
  test("own message without LINEJS isMyMessage flag must render on right",()=>{
    expect(resolveTalkOwnership(me,me,undefined)).toBe(true);
    expect(resolveTalkOwnership(me,me,false)).toBe(true);
    expect(reconcileTalkOwnership({isMine:false,raw:{from:me},text:"outgoing"},me).isMine).toBe(true);
  });
  test("other group member is never inferred as own",()=>{
    expect(resolveTalkOwnership(me,them,true)).toBe(false);
    expect(reconcileTalkOwnership({isMine:true,raw:{from:them}},me).isMine).toBe(false);
  });
  test("own message cached with senderId but no raw is corrected",()=>{
    expect(reconcileTalkOwnership({isMine:false,senderId:me},me).isMine).toBe(true);
  });
  test("unknown own MID uses explicit true only, never a display name",()=>{
    expect(resolveTalkOwnership("",me,false)).toBe(false);
    expect(resolveTalkOwnership("",me,true)).toBe(true);
    expect(resolveTalkOwnership(me,"",true)).toBe(true);
    expect(resolveTalkOwnership(me,"",false)).toBe(false);
  });
  test("group IDs cannot be mistaken for account MID",()=>{
    expect(resolveTalkOwnership(me,"c"+"c".repeat(32),false)).toBe(false);
    expect(resolveTalkOwnership(me,them,false)).toBe(false);
  });
});
