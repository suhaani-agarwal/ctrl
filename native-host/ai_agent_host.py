#!/usr/bin/env python3
# native-host/ai_agent_host.py
# Gives the Chrome extension full OS control via pyautogui
import sys, json, struct, subprocess, threading, time

try:
    import pyautogui
    pyautogui.FAILSAFE = True
    pyautogui.PAUSE = 0.05
except ImportError:
    pyautogui = None

try:
    import mss, mss.tools
except ImportError:
    mss = None

def read_msg():
    raw = sys.stdin.buffer.read(4)
    if not raw: return None
    length = struct.unpack("<I", raw)[0]
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))

def send_msg(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()

def handle(msg):
    if pyautogui is None:
        send_msg({"ok": False, "error": "pyautogui not installed. Run: pip install pyautogui pillow mss"})
        return

    kind = msg.get("kind", "")
    p    = msg.get("payload", {})

    try:
        if kind == "click":
            pyautogui.click(p["x"], p["y"])
            send_msg({"ok": True})

        elif kind == "double_click":
            pyautogui.doubleClick(p["x"], p["y"])
            send_msg({"ok": True})

        elif kind == "right_click":
            pyautogui.rightClick(p["x"], p["y"])
            send_msg({"ok": True})

        elif kind == "move":
            pyautogui.moveTo(p["x"], p["y"], duration=float(p.get("duration", 0.3)))
            send_msg({"ok": True})

        elif kind == "drag":
            pyautogui.dragTo(p["x"], p["y"], duration=float(p.get("duration", 0.5)), button="left")
            send_msg({"ok": True})

        elif kind == "type":
            pyautogui.typewrite(str(p["text"]), interval=float(p.get("interval", 0.03)))
            send_msg({"ok": True})

        elif kind == "hotkey":
            # e.g. keys: ["ctrl", "c"]
            pyautogui.hotkey(*p["keys"])
            send_msg({"ok": True})

        elif kind == "scroll":
            pyautogui.scroll(int(p.get("amount", -3)), x=p.get("x"), y=p.get("y"))
            send_msg({"ok": True})

        elif kind == "screenshot":
            if mss is None:
                send_msg({"ok": False, "error": "mss not installed"})
                return
            import base64, io
            with mss.mss() as sct:
                monitor = sct.monitors[int(p.get("monitor", 1))]
                img = sct.grab(monitor)
                from PIL import Image
                pil = Image.frombytes("RGB", img.size, img.bgra, "raw", "BGRX")
                buf = io.BytesIO()
                pil.save(buf, format="JPEG", quality=60)
                b64 = base64.b64encode(buf.getvalue()).decode()
            send_msg({"ok": True, "data": b64, "width": img.width, "height": img.height})

        elif kind == "open_app":
            subprocess.Popen(p["path"])
            send_msg({"ok": True})

        elif kind == "get_screen_size":
            w, h = pyautogui.size()
            send_msg({"ok": True, "width": w, "height": h})

        else:
            send_msg({"ok": False, "error": f"Unknown kind: {kind}"})

    except Exception as e:
        send_msg({"ok": False, "error": str(e)})

def main():
    def heartbeat():
        while True:
            time.sleep(25)
            try: send_msg({"type": "heartbeat"})
            except: break
    threading.Thread(target=heartbeat, daemon=True).start()

    while True:
        msg = read_msg()
        if msg is None: break
        if msg.get("type") == "os_action":
            handle(msg)

if __name__ == "__main__":
    main()