"""TEST-ONLY mock of a platform WebSocket: sends an asset list, an ACCOUNT message (must be
dropped by the bridge) and quote messages; records anything clients send to it."""
import asyncio, json, sys, time
import websockets
port, log_path = int(sys.argv[1]), sys.argv[2]
async def handler(ws):
    async def rx():
        async for m in ws:
            open(log_path, "a").write(m + "\n")
    asyncio.create_task(rx())
    for i in range(20):
        t = time.time()
        await ws.send(json.dumps({"action": "assets", "message": {"assets": [{"id": 151, "name": "BTCUSD OTC"}]}}))
        await ws.send(json.dumps({"action": "profile", "message": {"balance": 1000, "email": "x@y", "asset": 151, "price": 999, "time": t}}))
        await ws.send(json.dumps({"action": "candles", "message": {"asset": 151, "price": 50000 + i, "time": t}}))
        await asyncio.sleep(0.25)
    await asyncio.sleep(30)
async def main():
    async with websockets.serve(handler, "127.0.0.1", port):
        await asyncio.sleep(120)
asyncio.run(main())
