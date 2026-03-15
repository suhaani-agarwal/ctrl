#!/usr/bin/env python3
# native-host/setup.py
# Run this once: python3 setup.py
# It installs the native host manifest so Chrome can find it

import os, sys, json, subprocess, platform

EXTENSION_ID = input("Paste your Chrome extension ID (from chrome://extensions): ").strip()
HOST_NAME    = "com.ctrl.ai_agent_host"
SCRIPT_PATH  = os.path.abspath(os.path.join(os.path.dirname(__file__), "ai_agent_host.py"))

# Make sure Python path is executable
os.chmod(SCRIPT_PATH, 0o755)

# Create wrapper shell script (Chrome needs an executable, not .py directly on some systems)
wrapper = os.path.join(os.path.dirname(__file__), "ai_agent_host_wrapper.sh")
with open(wrapper, "w") as f:
    f.write(f"#!/bin/bash\nexec {sys.executable} {SCRIPT_PATH}\n")
os.chmod(wrapper, 0o755)

manifest = {
    "name": HOST_NAME,
    "description": "AI Agent native host for OS control",
    "path": wrapper,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"]
}

manifest_str = json.dumps(manifest, indent=2)

system = platform.system()

if system == "Darwin":  # macOS
    dest_dir = os.path.expanduser("~/Library/Application Support/Google/Chrome/NativeMessagingHosts/")
elif system == "Linux":
    dest_dir = os.path.expanduser("~/.config/google-chrome/NativeMessagingHosts/")
elif system == "Windows":
    dest_dir = os.path.expandvars(r"%APPDATA%\Google\Chrome\NativeMessagingHosts")
else:
    print("Unknown OS"); sys.exit(1)

os.makedirs(dest_dir, exist_ok=True)
dest = os.path.join(dest_dir, HOST_NAME + ".json")

with open(dest, "w") as f:
    f.write(manifest_str)

print(f"\n✅ Native host installed to:\n   {dest}")
print(f"\n📦 Now install Python dependencies:")
print(f"   pip install pyautogui mss Pillow")
print(f"\n🔄 Then reload your Chrome extension at chrome://extensions")
print(f"\nDone! The agent can now control your entire screen.")