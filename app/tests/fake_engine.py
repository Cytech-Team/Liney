#!/usr/bin/env python3
"""Test-only JSONL engine; NEVER reads accounts, network or SQLite."""
import json
import sys
import time

chats = [
    {"id":"c-test","kind":"group","name":"Native GUI verification","preview":"Offline cached chat","lastMessageTime":123,"unread":2},
    {"id":"u-test","kind":"dm","name":"Test Contact","preview":"Welcome to Liney 0.2","lastMessageTime":122},
]
messages = [
    {"id":"m-1","chatId":"c-test","senderName":"Test","text":"No WebKitGTK required.","createdTime":1761730800000,"isMine":False},
    {"id":"m-2","chatId":"c-test","text":"GTK4 + Libadwaita native UI","createdTime":1761730900000,"isMine":True},
]
for line in sys.stdin:
    try:
        req = json.loads(line)
        method = req["method"]
        if method == "ping":
            result = {"pong": True,"protocolVersion":1,"linejsVersion":"test"}
        elif method == "capabilities":
            result = {"protocolVersion":1,"authenticated":False}
        elif method == "chats.list":
            result = chats
        elif method == "message.list":
            result = messages if req.get("params", {}).get("chatId") == "c-test" else []
        elif method == "auth.qr.start":
            result = {"login": "testing"}
            print(json.dumps({"type":"auth.qr","url":"https://example.invalid/qr-test"}), flush=True)
        else:
            result = {}
        print(json.dumps({"id":req["id"],"ok":True,"result":result}), flush=True)
    except (ValueError, KeyError):
        pass
