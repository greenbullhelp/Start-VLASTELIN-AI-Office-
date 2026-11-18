// VLASTELIN — AI-асистент «Професор»: мальований (toon) 3D-бюст сивого вченого-генія
// Скуйовджене біле волосся, пишні вуса, добрі очі, сірий светр. Обведення контуром, як на малюнку.
import * as THREE from 'three';
import { noise3 } from './noise.js';

const g2 = (x, y, cx, cy, sx, sy) => Math.exp(-(((x - cx) / sx) ** 2 + ((y - cy) / sy) ** 2));
const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/* ================= МАТЕРІАЛИ «МАЛЮНКА» ================= */
function toonRamp() {
  const d = new Uint8Array([90, 170, 235, 255]);
  const t = new THREE.DataTexture(d, 4, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true;
  return t;
}
// контур: зворотні грані, зсунуті вздовж нормалі у просторі камери (товщина не залежить від масштабу деталі)
function outlineMaterial(width, color = 0x2b1a12) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uW: { value: width }, uC: { value: new THREE.Color(color) } },
    vertexShader: `uniform float uW; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); vec3 n = normalize(normalMatrix*normal);
      mv.xyz += n * uW * (-mv.z) * .09; gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uC; void main(){ gl_FragColor = vec4(uC,1.); }`
  });
}

/* ================= ГЕОМЕТРІЯ ================= */
// голова: м'яка «яйцеподібна» форма з щоками, підборіддям і вилицями старшої людини
function headShape(v) {
  const { x, y, z } = v, f = smooth(-.1, .45, z), ax = Math.abs(x);
  let sx = .86, sy = 1.04, sz = .94;
  if (y < 0) { const t = -y; sx *= 1 - .04 * t * t; sy *= 1 - .08 * t; }
  if (y > .3) sz *= 1 + .08 * (y - .3);
  let d = 0;
  d += .05 * g2(x, y, 0, .5, .5, .25) * f;                                // високий лоб
  d += .045 * (g2(x, y, .28, .27, .17, .06) + g2(x, y, -.28, .27, .17, .06)) * f;   // надбрівні дуги
  d -= .05 * (g2(x, y, .29, .12, .12, .07) + g2(x, y, -.29, .12, .07, .07)) * f;    // очниці
  d += .07 * (g2(ax, y, .42, -.15, .16, .16)) * f;                        // щоки
  d += .05 * (g2(ax, y, .38, -.5, .16, .14)) * f;                         // «брилі»
  d += .06 * g2(x, y, 0, -.72, .18, .1) * f;                              // підборіддя
  d -= .04 * g2(ax, y, .7, .25, .14, .2);                                 // скроні
  return new THREE.Vector3(x * sx, y * sy, z * sz).addScaledVector(v, d);
}
function headGeometry(q) {
  const g = new THREE.SphereGeometry(1, Math.round(128 * q), Math.round(96 * q));
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).normalize(); const s = headShape(v); p.setXYZ(i, s.x, s.y, s.z); }
  g.computeVertexNormals();
  return g;
}
const onHead = (x, y, z, out = 0) => { const v = new THREE.Vector3(x, y, z).normalize(); return headShape(v).addScaledVector(v, out); };

// нерівна «хмарка» волосся
function puffGeometry(r, seed, amp = .28) {
  const g = new THREE.IcosahedronGeometry(r, 4), p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = v.clone().normalize();
    const k = 1 + amp * noise3(n.x * 2.2 + seed, n.y * 2.2, n.z * 2.2) + amp * .5 * noise3(n.x * 5 + seed, n.y * 5, n.z * 5);
    p.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  g.computeVertexNormals();
  return g;
}
// звужене пасмо: трубка, радіус якої зменшується до кінчика
function strand(points, r0, seg = 14, rad = 6) {
  const curve = new THREE.CatmullRomCurve3(points);
  const g = new THREE.TubeGeometry(curve, seg, r0, rad, false), p = g.attributes.position, c = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    const u = Math.floor(i / (rad + 1)) / seg, k = Math.max(.08, 1 - u * .92);
    curve.getPointAt(u, c); v.fromBufferAttribute(p, i).sub(c).multiplyScalar(k).add(c); p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}
// злиття багатьох геометрій в одну (один виклик малювання)
function merge(list) {
  let nv = 0, ni = 0; list.forEach(g => { nv += g.attributes.position.count; ni += g.index.count; });
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  let ov = 0, oi = 0;
  list.forEach(g => {
    pos.set(g.attributes.position.array, ov * 3); nor.set(g.attributes.normal.array, ov * 3);
    const a = g.index.array; for (let i = 0; i < a.length; i++) idx[oi + i] = a[i] + ov;
    ov += g.attributes.position.count; oi += a.length; g.dispose();
  });
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3)); m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  m.setIndex(new THREE.BufferAttribute(idx, 1));
  return m;
}
// детермінований випадковий генератор, щоб зачіска була однаковою щоразу
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// скуйовджене волосся: корені на тімені, боках і потилиці; лоб відкритий
function hairStrands(count) {
  const rnd = rng(7), list = [];
  for (let i = 0; i < count; i++) {
    let d;
    do { d = new THREE.Vector3(rnd() * 2 - 1, rnd() * 1.4 - .25, rnd() * 2 - 1); } while (d.length() > 1 || d.length() < .3);
    d.normalize();
    if (d.z > .35 && d.y < .75) { i--; continue; }            // обличчя і лоб без волосся
    if (d.y < -.15 && d.z > -.2) { i--; continue; }           // не нижче вух спереду
    const root = headShape(d).multiplyScalar(.97);
    const out = d.clone().add(new THREE.Vector3(0, .15 + rnd() * .2, -.1)).normalize();
    const len = .4 + rnd() * .55 + (d.y > .6 ? .1 : 0), pts = [root.clone()];
    let p = root.clone(), dir = out.clone();
    for (let k = 1; k <= 4; k++) {
      const n = new THREE.Vector3(noise3(p.x * 2 + i, p.y * 2, p.z * 2), noise3(p.y * 2, p.z * 2 + i, p.x * 2), noise3(p.z * 2, p.x * 2, p.y * 2 + i));
      dir.addScaledVector(n, 1.4).normalize();
      p = p.clone().addScaledVector(dir, len / 4); pts.push(p);
    }
    list.push(strand(pts, .05 + rnd() * .035));
  }
  return merge(list);
}

// торс у светрі: м'які плечі, легка сутулість
function bodyGeometry(q) {
  const prof = [[.001, -5.6], [2.0, -5.6], [2.06, -4.6], [2.14, -3.5], [2.16, -2.95], [2.0, -2.45], [1.55, -2.12], [1.0, -1.95], [.62, -1.8],
    [.52, -1.5], [.001, -1.48]].map(([r, y]) => new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(new THREE.SplineCurve(prof).getPoints(Math.round(90 * q)), Math.round(120 * q), Math.PI);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), x = p.getX(i), k = .9 - .3 * smooth(-1.7, -2.3, y);
    let z = p.getZ(i) * k;
    if (z < 0) z -= .12 * smooth(-1.7, -2.6, y) * (1 - Math.abs(x) / 2.2);   // сутулість
    p.setZ(i, z);
  }
  g.computeVertexNormals();
  return g;
}
// светр: V-виріз із білою сорочкою, рубчики й темна лінія по краю виробу
function sweaterMaterial(ramp) {
  const m = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: ramp });
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vObj;')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
        vec3 knit = vec3(.33,.34,.38), shirt = vec3(.96,.95,.92);
        float w = .5 * clamp((vObj.y + 3.15) / 1.6, 0., 1.);           // ширина V-вирізу
        float front = step(0., vObj.z);
        float v = front * step(abs(vObj.x), w) * step(-3.15, vObj.y);
        float edge = front * (1. - smoothstep(.0, .05, abs(abs(vObj.x) - w))) * step(-3.15, vObj.y);
        float rib = .03 * sin(vObj.x * 60.) * (1. - v);
        vec3 col = mix(knit + rib, shirt, v);
        col = mix(col, vec3(.17,.11,.08), edge * .9);
        float placket = front * (1. - smoothstep(.0, .025, abs(vObj.x))) * step(vObj.y, -3.2);  // планка кардигана
        col = mix(col, vec3(.25,.25,.29), placket);
        vec4 diffuseColor = vec4( col, opacity );`);
  };
  return m;
}

function glowSprite(rgb) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, `rgba(${rgb},1)`); grd.addColorStop(.35, `rgba(${rgb},.4)`); grd.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: t, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
}

export function initAssistant(canvas, { lite = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const maxDpr = lite ? 1.5 : 2, Q = lite ? .6 : 1;
  renderer.setPixelRatio(Math.min(devicePixelRatio, maxDpr));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(24, 1, .1, 60);
  const ramp = toonRamp();
  const toon = color => new THREE.MeshToonMaterial({ color, gradientMap: ramp });
  const skin = toon(0xf2c29f), hairM = toon(0xf6f4ef), browM = toon(0xe2ded6), whiteM = toon(0xfbfaf6);
  const irisM = new THREE.MeshBasicMaterial({ color: 0x5b3b22 }), pupilM = new THREE.MeshBasicMaterial({ color: 0x120a06 });
  const mouthM = new THREE.MeshBasicMaterial({ color: 0x4a1d18 });
  const lineThick = outlineMaterial(.05), lineThin = outlineMaterial(.03);
  const ink = (mesh, mat = lineThick) => { mesh.add(new THREE.Mesh(mesh.geometry, mat)); return mesh; };
  const blob = (mat, s, pos, rot = [0, 0, 0], seg = 24) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, seg, Math.round(seg * .75)), mat);
    m.scale.set(...s); m.position.set(...pos); m.rotation.set(...rot); return m;
  };

  // ореол-статус за головою (блакитний — звичайний, золотий — слухає, фіолетовий — думає)
  const halo = glowSprite('110,200,255'); halo.scale.set(5.4, 5.4, 1); halo.position.set(0, -.15, -2.2); scene.add(halo);

  const bust = new THREE.Group(); scene.add(bust);
  const body = ink(new THREE.Mesh(bodyGeometry(Q), sweaterMaterial(ramp))); bust.add(body);
  const neck = ink(new THREE.Mesh(new THREE.CylinderGeometry(.46, .52, 1, 32), skin)); neck.position.y = -1.0; bust.add(neck);
  const collar = ink(new THREE.Mesh(new THREE.TorusGeometry(.5, .08, 10, 48), whiteM), lineThin);
  collar.rotation.x = Math.PI / 2 - .25; collar.position.set(0, -1.5, .06); collar.scale.set(1, 1.05, .7); bust.add(collar);
  [-3.45, -3.95, -4.45].forEach(y => bust.add(ink(blob(toon(0x3b3530), [.06, .06, .03], [0, y, 1.0]), lineThin)));   // ґудзики

  const head = new THREE.Group(); head.position.y = -.28; head.scale.setScalar(1.08); bust.add(head);
  head.add(ink(new THREE.Mesh(headGeometry(Q), skin)));

  // вуха
  [-1, 1].forEach(s => {
    const ear = ink(blob(skin, [.11, .24, .14], [.86 * s, .02, -.02], [0, 0, -.12 * s]));
    head.add(ear);
  });
  // ніс — великий, з «картоплинкою» на кінчику
  head.add(ink(blob(skin, [.1, .24, .13], onHead(0, -.04, 1, -.06).toArray(), [-.3, 0, 0])));
  head.add(ink(blob(skin, [.15, .12, .13], onHead(0, -.22, 1, .07).toArray())));
  [-1, 1].forEach(s => head.add(ink(blob(skin, [.08, .08, .08], onHead(.11 * s, -.26, 1, 0).toArray()), lineThin)));

  // очі: білки, райдужка, зіниця, відблиск; повіки опускаються при кліпанні
  const eyes = [];
  [-1, 1].forEach(s => {
    const c = onHead(.29 * s, .12, .9, -.06);
    const ball = new THREE.Group(); ball.position.copy(c); head.add(ball);
    ball.add(ink(blob(whiteM, [.15, .15, .12], [0, 0, 0]), lineThin));
    const iris = new THREE.Group(); ball.add(iris);
    iris.add(blob(irisM, [.085, .085, .03], [0, -.005, .115]));
    iris.add(blob(pupilM, [.042, .042, .02], [0, -.005, .135]));
    iris.add(blob(new THREE.MeshBasicMaterial({ color: 0xffffff }), [.02, .02, .01], [-.026, .024, .15]));
    const lid = ink(new THREE.Mesh(new THREE.SphereGeometry(.17, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), skin), lineThin);
    ball.add(lid);
    const lower = ink(new THREE.Mesh(new THREE.SphereGeometry(.162, 24, 8, 0, Math.PI * 2, Math.PI * .72, Math.PI * .28), skin), lineThin);
    lower.rotation.x = -.5; ball.add(lower);                   // мішечки під очима
    eyes.push({ iris, lid, s });
  });
  // кущисті брови
  const brows = [];
  [-1, 1].forEach(s => {
    const g = new THREE.Group(); g.position.copy(onHead(.3 * s, .3, .9, .02)); head.add(g);
    for (let k = 0; k < 6; k++) {
      const u = k / 5;
      g.add(ink(blob(browM, [.075, .035, .04], [(-.13 + u * .26) * s, .02 * Math.sin(u * Math.PI) - u * .05, 0], [0, 0, (.5 - u) * .5 * s + (u - .5) * .3]), lineThin));
    }
    brows.push({ g, y0: g.position.y });
  });
  // зморшки на лобі
  [.5, .58, .66].forEach((y, i) => {
    const pts = [-.32, -.16, 0, .16, .32].map(x => onHead(x, y + .02 * Math.cos(x * 8 + i), .85, .004));
    head.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 30, .007, 5), new THREE.MeshBasicMaterial({ color: 0xa7724f })));
  });

  // рот і пишні вуса
  const mouth = blob(mouthM, [.15, .03, .05], onHead(0, -.5, .86, -.01).toArray()); head.add(mouth);
  head.add(ink(blob(skin, [.15, .05, .07], onHead(0, -.58, .84, -.02).toArray()), lineThin));     // нижня губа
  const stache = new THREE.Group(); stache.position.copy(onHead(0, -.36, 1, -.02)); head.add(stache);
  const stacheY = stache.position.y;
  stache.add(ink(blob(hairM, [.3, .1, .1], [0, 0, 0])));
  for (let k = 0; k < 12; k++) {
    const u = k / 11 - .5, s = Math.sign(u) || 1;
    stache.add(ink(blob(hairM, [.06, .15, .06], [u * .62, -.07 - Math.abs(u) * .12, -Math.abs(u) * .12], [0, 0, u * 1.1 + s * .05]), lineThin));
  }

  // знамените скуйовджене волосся: «хмари» + розкуйовджені пасма
  const hair = new THREE.Group(); head.add(hair);
  [[[-.98, .3, -.3], .58, 1], [[.98, .3, -.3], .58, 2], [[-.72, .72, -.2], .5, 3], [[.72, .72, -.2], .5, 4], [[0, .88, -.4], .62, 5],
   [[0, .35, -.8], .65, 6], [[-.8, -.15, -.45], .45, 7], [[.8, -.15, -.45], .45, 8], [[-.3, .98, .1], .34, 9], [[.3, .98, .1], .34, 10], [[-1.18, -.05, -.1], .36, 11], [[1.18, -.05, -.1], .36, 12]]
    .forEach(([pos, r, seed]) => { const m = ink(new THREE.Mesh(puffGeometry(r, seed), hairM)); m.position.set(...pos); hair.add(m); });
  const strands = ink(new THREE.Mesh(hairStrands(lite ? 45 : 90), hairM), lineThin); hair.add(strands);

  // світло: тепле ключове, м'яке заповнення, кольоровий контур від HUD
  scene.add(new THREE.AmbientLight(0xffffff, .8));
  scene.add(new THREE.HemisphereLight(0xdfeaff, 0x553322, .6));
  const key = new THREE.DirectionalLight(0xfff1e0, 2.4); key.position.set(-3, 4, 6); scene.add(key);
  const rim = new THREE.DirectionalLight(0x7cc8ff, .9); rim.position.set(4, 2, -3); scene.add(rim);

  let big = false;
  function frame() {
    const r = canvas.getBoundingClientRect(); if (!r.width) return;
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    if (big) { camera.position.set(0, -.7, 14); camera.lookAt(0, -1.15, 0); }
    else { camera.position.set(0, -.6, 12); camera.lookAt(0, -.8, 0); }
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(frame).observe(canvas); frame();

  const ptr = { x: 0, y: 0, sx: 0, sy: 0 };
  addEventListener('pointermove', e => { ptr.x = e.clientX / innerWidth * 2 - 1; ptr.y = e.clientY / innerHeight * 2 - 1; });

  let speaking = 0, listening = false, thinking = false, eco = false, nextBlink = 2, blink = 0;
  const clock = new THREE.Clock();
  const cCyan = new THREE.Color(0x6ec8ff), cGold = new THREE.Color(0xffc45a), cThink = new THREE.Color(0xc59bff);
  let paused = false, onScreen = true, raf = 0, last = 0;
  const minFrame = lite ? 1000 / 31 : 0;
  const active = () => !paused && onScreen && !document.hidden;
  function wake() { if (!raf && active()) { clock.getDelta(); raf = requestAnimationFrame(loop); } }
  document.addEventListener('visibilitychange', wake);
  if ('IntersectionObserver' in window) new IntersectionObserver(es => { onScreen = es[es.length - 1].isIntersecting; wake(); }).observe(canvas);
  function loop(now) {
    raf = 0;
    if (!active()) return;
    raf = requestAnimationFrame(loop);
    if (minFrame && now - last < minFrame) return;
    last = now;
    const dt = Math.min(clock.getDelta(), .05), t = clock.elapsedTime, sp = eco ? .4 : 1;
    ptr.sx += (ptr.x - ptr.sx) * .05; ptr.sy += (ptr.y - ptr.sy) * .05;
    head.rotation.y = Math.sin(t * .33 * sp) * .15 + ptr.sx * .3 + (thinking ? Math.sin(t * 1.2) * .06 : 0);
    head.rotation.x = Math.sin(t * .25 * sp) * .03 + ptr.sy * .1 - (thinking ? .1 : 0);
    head.rotation.z = Math.sin(t * .2 * sp) * .03 + (thinking ? .08 : 0);
    bust.rotation.y = head.rotation.y * .2;
    const breath = Math.sin(t * 1.1 * sp);
    body.scale.set(1 + breath * .006, 1, 1 + breath * .012); bust.position.y = breath * .02;
    // волосся ледь «живе»
    hair.rotation.z = Math.sin(t * .9 * sp) * .012; hair.scale.setScalar(1 + Math.sin(t * .7 * sp) * .006);
    // очі стежать за курсором; при роздумах — дивляться вгору
    eyes.forEach(({ iris }) => {
      iris.rotation.y = ptr.sx * .35; iris.rotation.x = thinking ? -.45 : ptr.sy * .3;
    });
    nextBlink -= dt; if (nextBlink < 0) { blink = 1; nextBlink = 2.5 + Math.random() * 4; }
    blink = Math.max(0, blink - dt * 6);
    const lidOpen = listening ? -.7 : -.4;                      // слухає — очі ширше
    eyes.forEach(({ lid }) => { lid.rotation.x = lidOpen + (.95 - lidOpen) * Math.min(1, blink * 1.6); });
    const browUp = listening ? .05 : thinking ? .03 * Math.sin(t * 3) + .02 : 0;
    brows.forEach((b, i) => { b.g.position.y = b.y0 + browUp + (thinking && i ? .03 : 0); });
    speaking = Math.max(0, speaking - dt * .5);
    const talk = speaking > 0 ? Math.abs(Math.sin(t * 11)) * (.6 + .4 * Math.sin(t * 3.7)) : 0;
    mouth.scale.y = .03 + talk * .07; stache.position.y = stacheY + talk * .02;
    const col = listening ? cGold : thinking ? cThink : cCyan;
    halo.material.color.lerp(col, .08);
    halo.material.opacity = (listening ? .75 + .2 * Math.sin(t * 8) : thinking ? .6 + .3 * Math.sin(t * 4) : .45 + .08 * Math.sin(t * 2)) + talk * .2;
    renderer.render(scene, camera);
  }
  wake();

  return {
    speak(sec = 3) { speaking = Math.min(4, sec / 2); },
    listen(v) { listening = v; },
    think(v) { thinking = v; },
    setBig(v) { big = v; setTimeout(frame, 30); },
    setEco(v) { eco = v; renderer.setPixelRatio(Math.min(devicePixelRatio, v ? 1 : maxDpr)); frame(); },
    setPaused(v) { paused = v; wake(); }
  };
}
