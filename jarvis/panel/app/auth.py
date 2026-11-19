"""Вхід лише для власника: пароль (scrypt) + двофакторний код (TOTP, RFC 6238).

* Пароль задається на сервері командою `python -m app.cli set-password`.
* 2FA підключається під час першого входу (QR-код або посилання для «Паролів» iPhone).
* Захист від підбору: після 5 невдалих спроб за 15 хв з однієї адреси вхід блокується.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

from . import db
from .config import settings
from .core import audit

MAX_FAILS = 5
WINDOW = 15 * 60
ENROLL_TTL = 10 * 60
_enroll: dict[str, tuple[str, float]] = {}  # тимчасовий токен підключення 2FA → (секрет, час)


# ---------- пароль ----------
def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(h).decode()


def verify_password(pw: str, stored: str) -> bool:
    try:
        _, salt_b64, h_b64 = stored.split("$")
        salt, want = base64.b64decode(salt_b64), base64.b64decode(h_b64)
    except ValueError:
        return False
    got = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return hmac.compare_digest(got, want)


def set_password(pw: str) -> None:
    if len(pw) < 10:
        raise ValueError("Пароль має бути щонайменше 10 символів")
    if db.one("SELECT id FROM owner WHERE id=1"):
        db.run("UPDATE owner SET pw_hash=?, updated=? WHERE id=1", (hash_password(pw), db.now()))
    else:
        db.insert("owner", id=1, pw_hash=hash_password(pw), updated=db.now())
    db.run("DELETE FROM sessions")  # нові сесії — лише з новим паролем
    audit("owner", "password_set", "Пароль змінено, усі сесії завершено", "warn")


def reset_2fa() -> None:
    db.run("UPDATE owner SET totp_secret='', totp_enabled=0, updated=? WHERE id=1", (db.now(),))
    db.run("DELETE FROM sessions")
    audit("owner", "2fa_reset", "2FA скинуто з консолі сервера", "warn")


# ---------- TOTP ----------
def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def totp_code(secret: str, t: float | None = None, step: int = 30) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    counter = int((t if t is not None else time.time()) // step)
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    o = mac[-1] & 0x0F
    code = (struct.unpack(">I", mac[o:o + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{code:06d}"


def verify_totp(secret: str, code: str) -> bool:
    code = "".join(ch for ch in str(code) if ch.isdigit())
    if len(code) != 6 or not secret:
        return False
    now = time.time()
    return any(hmac.compare_digest(totp_code(secret, now + d * 30), code) for d in (-1, 0, 1))


def otpauth_url(secret: str) -> str:
    label = quote(f"Jarvis:{settings.owner_name}")
    return f"otpauth://totp/{label}?secret={secret}&issuer=Jarvis&digits=6&period=30"


def qr_svg(data: str) -> str:
    import segno  # невелика бібліотека без залежностей

    return segno.make(data, error="m").svg_inline(scale=5, dark="#e8eef7", light="#0b1220", border=2)


# ---------- захист від підбору ----------
def too_many_fails(ip: str) -> bool:
    since = time.time() - WINDOW
    r = db.one("SELECT COUNT(*) AS n FROM login_attempts WHERE ip=? AND ts>? AND ok=0", (ip, since))
    total = db.one("SELECT COUNT(*) AS n FROM login_attempts WHERE ts>? AND ok=0", (since,))
    return (r["n"] if r else 0) >= MAX_FAILS or (total["n"] if total else 0) >= MAX_FAILS * 6


def note_attempt(ip: str, ok: bool) -> None:
    db.insert("login_attempts", ip=ip, ts=time.time(), ok=int(ok))
    db.run("DELETE FROM login_attempts WHERE ts<?", (time.time() - 86400,))


# ---------- сесії ----------
def _h(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(ip: str, ua: str) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    db.insert("sessions", token_hash=_h(token), created=now, expires=now + settings.session_days * 86400,
              ip=ip, ua=ua[:200])
    return token


def check_session(token: str | None) -> bool:
    if not token:
        return False
    r = db.one("SELECT expires FROM sessions WHERE token_hash=?", (_h(token),))
    return bool(r and r["expires"] > time.time())


def drop_session(token: str | None) -> None:
    if token:
        db.run("DELETE FROM sessions WHERE token_hash=?", (_h(token),))


def drop_all_sessions() -> None:
    db.run("DELETE FROM sessions")


# ---------- вхід ----------
def owner() -> dict | None:
    return db.one("SELECT * FROM owner WHERE id=1")


def login(password: str, code: str, ip: str, ua: str) -> dict:
    """Повертає {ok, token} або {enroll, enroll_token, otpauth, qr} або {error}."""
    if too_many_fails(ip):
        audit("system", "login_blocked", f"Забагато невдалих спроб з {ip}", "warn")
        return {"error": "Забагато невдалих спроб. Спробуйте через 15 хвилин."}
    o = owner()
    if not o:
        return {"error": "Пароль ще не задано. Виконайте на сервері: docker compose exec panel python -m app.cli set-password"}
    if not verify_password(password, o["pw_hash"]):
        note_attempt(ip, False)
        audit("system", "login_failed", f"Невірний пароль з {ip}", "warn")
        return {"error": "Невірний пароль або код"}
    if not o["totp_enabled"]:
        secret = new_totp_secret()
        tok = secrets.token_urlsafe(24)
        _enroll[tok] = (secret, time.time())
        url = otpauth_url(secret)
        return {"enroll": True, "enroll_token": tok, "otpauth": url, "secret": secret, "qr": qr_svg(url)}
    if not verify_totp(o["totp_secret"], code):
        note_attempt(ip, False)
        audit("system", "login_failed", f"Невірний код 2FA з {ip}", "warn")
        return {"error": "Невірний пароль або код"}
    note_attempt(ip, True)
    audit("owner", "login", f"Вхід з {ip}")
    return {"ok": True, "token": create_session(ip, ua)}


def finish_enroll(enroll_token: str, code: str, ip: str, ua: str) -> dict:
    item = _enroll.get(enroll_token)
    if not item or time.time() - item[1] > ENROLL_TTL:
        return {"error": "Час підключення 2FA минув. Увійдіть паролем ще раз."}
    secret = item[0]
    if not verify_totp(secret, code):
        note_attempt(ip, False)
        return {"error": "Код не підходить. Перевірте час на телефоні й спробуйте ще раз."}
    _enroll.pop(enroll_token, None)
    db.run("UPDATE owner SET totp_secret=?, totp_enabled=1, updated=? WHERE id=1", (secret, db.now()))
    note_attempt(ip, True)
    audit("owner", "2fa_enabled", "Двофакторну автентифікацію підключено", "warn")
    return {"ok": True, "token": create_session(ip, ua)}
