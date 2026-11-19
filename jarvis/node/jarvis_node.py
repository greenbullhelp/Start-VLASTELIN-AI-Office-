"""Джарвіс — вузол на домашньому ПК (Windows).

Що робить:
  * стартує разом із Windows (Планувальник завдань), підключається до сервера через Tailscale;
  * показує значок у треї: зелений — онлайн, жовтий — працює, червоний — немає зв'язку;
  * забирає з сервера задачі й виконує ЛИШЕ дії зі списку allowed_actions у config.toml:
    графіка (ComfyUI або Stable Diffusion WebUI), монтаж (FFmpeg), субтитри (Whisper);
  * результати відправляє назад на сервер. Жодних довільних команд — тільки готові дії нижче.

Запуск вручну:  python jarvis_node.py        (у вікні, з журналом)
Перевірка:      python jarvis_node.py --check
"""
from __future__ import annotations

import json
import logging
import os
import platform
import random
import re
import shutil
import subprocess
import sys
import threading
import time
import tomllib
from pathlib import Path

import httpx

VERSION = "1.0.0"
HERE = Path(__file__).resolve().parent
log = logging.getLogger("jarvis-node")

DEFAULT_ALLOWED = ["ping", "comfy_generate", "sd_generate", "ffmpeg_cut", "ffmpeg_concat", "ffmpeg_transcode",
                   "whisper_subtitles", "burn_subtitles", "transcribe"]


# ---------- налаштування ----------
def load_config() -> dict:
    p = HERE / "config.toml"
    if not p.exists():
        sys.exit("Немає config.toml — скопіюйте config.example.toml у config.toml і заповніть (див. docs/PC_NODE.md)")
    cfg = tomllib.loads(p.read_text(encoding="utf-8"))
    cfg.setdefault("name", platform.node() or "pc")
    cfg.setdefault("allowed_actions", DEFAULT_ALLOWED)
    cfg.setdefault("work_dir", str(HERE / "work"))
    cfg.setdefault("comfy_url", "http://127.0.0.1:8188")
    cfg.setdefault("sd_url", "http://127.0.0.1:7860")
    cfg.setdefault("image_backend", "comfy")
    cfg.setdefault("checkpoint", "sdxl_base_1.0.safetensors")
    cfg.setdefault("whisper_device", "cuda")
    cfg.setdefault("ffmpeg", shutil.which("ffmpeg") or "ffmpeg")
    Path(cfg["work_dir"]).mkdir(parents=True, exist_ok=True)
    return cfg


# ---------- стан для трея ----------
class State:
    online = False
    busy: int | None = None
    last_error = ""
    stop = threading.Event()


S = State()


def safe_path(cfg: dict, rel: str) -> Path:
    """Шлях лише всередині робочої папки вузла."""
    base = Path(cfg["work_dir"]).resolve()
    p = (base / rel).resolve()
    if base not in p.parents and p != base:
        raise ValueError(f"шлях поза робочою папкою: {rel}")
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


# ---------- дії ----------
def act_ping(cfg, c, p):
    return {"pong": True, "time": time.time()}, []


def act_comfy(cfg, c, p):
    """ComfyUI: шаблон workflow з comfy_workflow.json (SDXL, оптимізовано під 8 ГБ VRAM)."""
    wf = json.loads((HERE / "comfy_workflow.json").read_text(encoding="utf-8"))
    text = json.dumps(wf)
    for k, v in {"__PROMPT__": p["prompt"], "__NEGATIVE__": p["negative"], "__CKPT__": cfg["checkpoint"]}.items():
        text = text.replace(k, json.dumps(v)[1:-1])
    wf = json.loads(text)
    for node in wf.values():
        ins = node.get("inputs", {})
        if node.get("class_type") == "EmptyLatentImage":
            ins.update(width=p["width"], height=p["height"], batch_size=1)
        if node.get("class_type") == "KSampler":
            ins.update(seed=p["seed"], steps=p["steps"])
        if node.get("class_type") == "SaveImage":
            ins["filename_prefix"] = "jarvis_" + p["out_name"]
    base = cfg["comfy_url"].rstrip("/")
    r = httpx.post(f"{base}/prompt", json={"prompt": wf, "client_id": "jarvis-node"}, timeout=30)
    r.raise_for_status()
    pid = r.json()["prompt_id"]
    for _ in range(900):
        time.sleep(1)
        h = httpx.get(f"{base}/history/{pid}", timeout=10).json()
        if pid in h:
            outs = [img for o in h[pid].get("outputs", {}).values() for img in o.get("images", [])]
            if not outs:
                raise RuntimeError("ComfyUI не повернув зображення")
            img = outs[0]
            data = httpx.get(f"{base}/view", params={"filename": img["filename"], "subfolder": img.get("subfolder", ""),
                                                     "type": img.get("type", "output")}, timeout=60).content
            out = safe_path(cfg, f"art/{p['out_name']}.png")
            out.write_bytes(data)
            return {"backend": "comfyui"}, [out]
    raise TimeoutError("ComfyUI не впорався за 15 хв")


def act_sd(cfg, c, p):
    """Stable Diffusion WebUI (AUTOMATIC1111/Forge) з --api, напр. з прапорцем --medvram для 8 ГБ."""
    import base64

    r = httpx.post(cfg["sd_url"].rstrip("/") + "/sdapi/v1/txt2img", timeout=900, json={
        "prompt": p["prompt"], "negative_prompt": p["negative"], "width": p["width"], "height": p["height"],
        "seed": p["seed"], "steps": p["steps"], "cfg_scale": 6.5, "sampler_name": "DPM++ 2M Karras"})
    r.raise_for_status()
    out = safe_path(cfg, f"art/{p['out_name']}.png")
    out.write_bytes(base64.b64decode(r.json()["images"][0]))
    return {"backend": "sd-webui"}, [out]


def act_image(cfg, c, p):
    side = int(cfg.get("max_side", 1216))
    k = side / max(p["width"], p["height"])
    p = {**p, "width": int(p["width"] * k) // 8 * 8, "height": int(p["height"] * k) // 8 * 8}
    order = [act_comfy, act_sd] if cfg["image_backend"] == "comfy" else [act_sd, act_comfy]
    errors = []
    for fn in order:
        try:
            return fn(cfg, c, p)
        except (httpx.HTTPError, OSError) as e:
            errors.append(f"{fn.__name__}: {type(e).__name__}")
    raise RuntimeError("Немає доступного генератора зображень (запустіть ComfyUI або SD WebUI): " + "; ".join(errors))


def fetch(cfg, c, rel: str) -> Path:
    """Завантажує вхідний файл із сервера (якщо його ще немає локально)."""
    dest = safe_path(cfg, rel)
    if not dest.exists():
        with c.stream("GET", "/node/files", params={"path": rel}, timeout=600) as r:
            r.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in r.iter_bytes(1 << 20):
                    f.write(chunk)
    return dest


def ffmpeg(cfg, args: list[str]) -> None:
    cmd = [cfg["ffmpeg"], "-hide_banner", "-loglevel", "error", "-y", *args]
    log.info("ffmpeg %s", " ".join(args[:6]))
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=6 * 3600,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if res.returncode != 0:
        raise RuntimeError("FFmpeg: " + res.stderr[-400:])


def act_cut(cfg, c, p):
    src, out = fetch(cfg, c, p["input"]), safe_path(cfg, p["output"])
    ffmpeg(cfg, ["-ss", str(p["start"]), "-to", str(p["end"]), "-i", str(src), "-c:v", "libx264", "-crf", "20", "-c:a", "aac", str(out)])
    return {}, [out]


def act_concat(cfg, c, p):
    files = [fetch(cfg, c, x) for x in p["inputs"]]
    lst = safe_path(cfg, f"tmp/concat-{int(time.time())}.txt")
    lst.write_text("\n".join(f"file '{f.as_posix()}'" for f in files), encoding="utf-8")
    out = safe_path(cfg, p["output"])
    ffmpeg(cfg, ["-f", "concat", "-safe", "0", "-i", str(lst), "-c:v", "libx264", "-crf", "20", "-c:a", "aac", str(out)])
    return {}, [out]


PRESETS = {
    "youtube_1080p": ["-vf", "scale=-2:1080", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
    "shorts_vertical": ["-vf", "crop=ih*9/16:ih,scale=1080:1920", "-c:v", "libx264", "-crf", "21", "-c:a", "aac", "-movflags", "+faststart"],
    "preview_480p": ["-vf", "scale=-2:480", "-c:v", "libx264", "-crf", "28", "-c:a", "aac", "-b:a", "96k"],
    "audio_mp3": ["-vn", "-c:a", "libmp3lame", "-q:a", "2"],
}


def act_transcode(cfg, c, p):
    src, out = fetch(cfg, c, p["input"]), safe_path(cfg, p["output"])
    ffmpeg(cfg, ["-i", str(src), *PRESETS[p["preset"]], str(out)])
    return {"preset": p["preset"]}, [out]


_whisper = {}


def whisper_model(cfg, name: str):
    from faster_whisper import WhisperModel  # pip install faster-whisper (GPU: CUDA 12 + cuDNN)

    if name not in _whisper:
        dev = cfg["whisper_device"]
        try:
            _whisper[name] = WhisperModel(name, device=dev, compute_type="int8_float16" if dev == "cuda" else "int8")
        except Exception:
            _whisper[name] = WhisperModel(name, device="cpu", compute_type="int8")
    return _whisper[name]


def _srt_time(t: float) -> str:
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def act_whisper(cfg, c, p):
    src, out = fetch(cfg, c, p["input"]), safe_path(cfg, p["output"])
    segs, _ = whisper_model(cfg, p["model"]).transcribe(str(src), language=p["language"], vad_filter=True)
    lines = [f"{i}\n{_srt_time(s.start)} --> {_srt_time(s.end)}\n{s.text.strip()}\n" for i, s in enumerate(segs, 1)]
    out.write_text("\n".join(lines), encoding="utf-8")
    return {"segments": len(lines)}, [out]


def act_burn(cfg, c, p):
    src, subs, out = fetch(cfg, c, p["input"]), fetch(cfg, c, p["subtitles"]), safe_path(cfg, p["output"])
    sub = subs.as_posix().replace(":", r"\:")
    ffmpeg(cfg, ["-i", str(src), "-vf", f"subtitles='{sub}':force_style='FontName=Arial,FontSize=20,Outline=2'", "-c:a", "copy", str(out)])
    return {}, [out]


def act_transcribe(cfg, c, p):
    src = fetch(cfg, c, p["input"])
    segs, _ = whisper_model(cfg, "small").transcribe(str(src), language="uk", vad_filter=True)
    return {"text": " ".join(s.text.strip() for s in segs)}, []


ACTIONS = {"ping": act_ping, "comfy_generate": act_image, "sd_generate": act_image, "ffmpeg_cut": act_cut,
           "ffmpeg_concat": act_concat, "ffmpeg_transcode": act_transcode, "whisper_subtitles": act_whisper,
           "burn_subtitles": act_burn, "transcribe": act_transcribe}


# ---------- зв'язок із сервером ----------
def client(cfg) -> httpx.Client:
    return httpx.Client(base_url=cfg["server"].rstrip("/"), timeout=60, headers={"X-Node-Token": cfg["token"]})


def tools(cfg) -> dict:
    def up(url):
        try:
            return httpx.get(url, timeout=2).status_code < 500
        except httpx.HTTPError:
            return False
    try:
        import faster_whisper  # noqa: F401
        has_whisper = True
    except ImportError:
        has_whisper = False
    return {"ffmpeg": bool(shutil.which(cfg["ffmpeg"]) or Path(cfg["ffmpeg"]).exists()), "whisper": has_whisper,
            "comfyui": up(cfg["comfy_url"] + "/system_stats"), "sd_webui": up(cfg["sd_url"] + "/sdapi/v1/sd-models")}


def gpu_name() -> str:
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True,
                           text=True, timeout=5, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return r.stdout.strip().splitlines()[0] if r.returncode == 0 and r.stdout.strip() else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def heartbeat_loop(cfg) -> None:
    gpu, last_tools, t_tools = gpu_name(), {}, 0
    with client(cfg) as c:
        while not S.stop.is_set():
            if time.time() - t_tools > 300:
                last_tools, t_tools = tools(cfg), time.time()
            try:
                r = c.post("/node/heartbeat", json={"name": cfg["name"], "version": VERSION, "gpu": gpu,
                                                    "actions": cfg["allowed_actions"], "tools": last_tools, "busy": S.busy})
                S.online = r.status_code == 200
                S.last_error = "" if S.online else f"HTTP {r.status_code}"
            except httpx.HTTPError as e:
                S.online, S.last_error = False, type(e).__name__
            S.stop.wait(20)


def run_job(cfg, c, job: dict) -> None:
    jid, action, params = job["id"], job["action"], job.get("params") or {}
    S.busy = jid
    files: list[Path] = []
    try:
        if action not in cfg["allowed_actions"] or action not in ACTIONS:
            raise PermissionError(f"дія «{action}» не дозволена на цьому ПК (allowed_actions у config.toml)")
        log.info("задача #%s: %s", jid, action)
        result, files = ACTIONS[action](cfg, c, params)
        data = {"status": "done", "result": json.dumps(result, ensure_ascii=False)}
    except Exception as e:  # про помилку чесно повідомляємо сервер
        log.exception("задача #%s не вдалася", jid)
        data = {"status": "error", "error": f"{type(e).__name__}: {e}"[:900]}
    try:
        handles = [("files", (f.name, open(f, "rb"))) for f in files]
        try:
            c.post(f"/node/jobs/{jid}/result", data=data, files=handles or None, timeout=1800)
        finally:
            for _, (_, h) in handles:
                h.close()
    finally:
        S.busy = None


def jobs_loop(cfg) -> None:
    with client(cfg) as c:
        while not S.stop.is_set():
            try:
                r = c.get("/node/jobs/next", params={"wait": 25, "name": cfg["name"]}, timeout=40)
                if r.status_code == 200:
                    run_job(cfg, c, r.json())
                    continue
                if r.status_code == 401:
                    S.last_error = "невірний токен"
                    S.stop.wait(60)
            except httpx.HTTPError:
                S.stop.wait(10 + random.random() * 5)


# ---------- трей ----------
def tray(cfg) -> None:
    try:
        import pystray
        from PIL import Image, ImageDraw
    except ImportError:
        log.info("pystray не встановлено — працюю без значка в треї")
        S.stop.wait()
        return

    def icon_img(color):
        img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.ellipse((6, 6, 58, 58), fill=(7, 9, 13, 255), outline=(201, 168, 92, 255), width=3)
        d.ellipse((20, 20, 44, 44), fill=color)
        return img

    imgs = {"on": icon_img((60, 207, 145, 255)), "busy": icon_img((240, 180, 76, 255)), "off": icon_img((239, 91, 91, 255))}

    def title():
        if not S.online:
            return f"Джарвіс-вузол: ОФЛАЙН ({S.last_error or 'немає зв`язку'})"
        return f"Джарвіс-вузол: працює над задачею #{S.busy}" if S.busy else "Джарвіс-вузол: онлайн"

    def quit_(icon, _):
        S.stop.set()
        icon.stop()

    icon = pystray.Icon("jarvis-node", imgs["off"], title(),
                        menu=pystray.Menu(pystray.MenuItem(lambda _: title(), None, enabled=False),
                                          pystray.MenuItem("Відкрити папку результатів", lambda *_: os.startfile(cfg["work_dir"])),
                                          pystray.MenuItem("Вийти", quit_)))

    def refresh():
        while not S.stop.is_set():
            icon.icon = imgs["busy" if S.busy else "on" if S.online else "off"]
            icon.title = title()
            S.stop.wait(3)

    threading.Thread(target=refresh, daemon=True).start()
    icon.run()


def check(cfg) -> int:
    print(f"Джарвіс-вузол {VERSION} · {cfg['name']} · сервер {cfg['server']}")
    print("GPU:", gpu_name() or "не знайдено (nvidia-smi)")
    for k, v in tools(cfg).items():
        print(f"  {k:10s} {'OK' if v else '—'}")
    try:
        with client(cfg) as c:
            r = c.post("/node/heartbeat", json={"name": cfg["name"], "version": VERSION, "actions": cfg["allowed_actions"]})
            print("Сервер:", "OK, вузол онлайн" if r.status_code == 200 else f"помилка HTTP {r.status_code}")
            return 0 if r.status_code == 200 else 1
    except httpx.HTTPError as e:
        print("Сервер недоступний:", type(e).__name__, "— перевірте Tailscale і адресу server у config.toml")
        return 1


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.FileHandler(HERE / "jarvis_node.log", encoding="utf-8"), logging.StreamHandler()])
    cfg = load_config()
    if not re.match(r"^https?://", cfg.get("server", "")) or not cfg.get("token"):
        sys.exit("У config.toml потрібні server (http://100.x.y.z:8100) і token")
    if "--check" in sys.argv:
        return check(cfg)
    log.info("Джарвіс-вузол %s запущено (%s), дозволені дії: %s", VERSION, cfg["name"], ", ".join(cfg["allowed_actions"]))
    threading.Thread(target=heartbeat_loop, args=(cfg,), daemon=True).start()
    threading.Thread(target=jobs_loop, args=(cfg,), daemon=True).start()
    try:
        tray(cfg)
    except KeyboardInterrupt:
        S.stop.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
