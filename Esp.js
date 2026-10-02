// ==UserScript==
// @name         Krunker ESP
// @namespace    krunker-esp-local
// @version      1.0
// @description  Box ESP + Wireframe ESP for Krunker.io — no aimbot, no triggerbot, visual only
// @author       Kovak
// @match        *://krunker.io/*
// @match        *://*.krunker.io/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        enabled: true,
        box: true,
        wireframe: false,
        enemyColor: 0xff2b2b,
        teamColor: 0x2bff6a,
        boxOpacity: 0.85,
        wireOpacity: 0.5,
        boxPadding: 1.05,
        hotkeys: {
            master: 'KeyM',
            box: 'KeyB',
            wireframe: 'KeyV',
            menu: 'KeyN'
        }
    };

    const state = {
        scene: null,
        camera: null,
        espMap: new Map(), // mesh.uuid -> { box, wire, lastPos }
        originalMats: new Map(),
        menuEl: null,
        menuVisible: false
    };

    // ---------- persistence ----------
    function load() {
        try {
            const raw = localStorage.getItem('krunker-esp-cfg');
            if (raw) Object.assign(CONFIG, JSON.parse(raw));
        } catch (_) {}
    }
    function save() {
        try {
            localStorage.setItem('krunker-esp-cfg', JSON.stringify(CONFIG));
        } catch (_) {}
    }

    // ---------- THREE hook ----------
    function waitForThree(cb) {
        const iv = setInterval(() => {
            if (typeof window.THREE !== 'undefined' && window.THREE.WebGLRenderer) {
                clearInterval(iv);
                cb(window.THREE);
            }
        }, 120);
    }

    function hookRenderer(THREE) {
        const proto = THREE.WebGLRenderer.prototype;
        if (proto.__espHooked) return;
        proto.__espHooked = true;
        const orig = proto.render;
        proto.render = function (sc, cam) {
            state.scene = sc;
            state.camera = cam;
            try { updateESP(THREE); } catch (e) { console.error('[ESP]', e); }
            return orig.apply(this, arguments);
        };
    }

    // ---------- player discovery ----------
    function isPlayerMesh(obj) {
        if (!obj || !obj.isMesh) return false;
        const p = obj.player || obj.userData?.player;
        if (!p) return false;
        if (p.active === false) return false;
        if (p.isYou === true) return false;
        return true;
    }

    function localTeam() {
        const lp = window.localPlayer || window.me || window.game?.localPlayer;
        return lp?.team ?? null;
    }

    function collectPlayers(THREE) {
        const list = [];
        if (!state.scene) return list;
        state.scene.traverse((o) => {
            if (isPlayerMesh(o)) list.push(o);
        });
        return list;
    }

    // ---------- box ----------
    function buildBox(THREE, mesh, color) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const bb = mesh.geometry.boundingBox.clone();
        const size = bb.getSize(new THREE.Vector3()).multiplyScalar(CONFIG.boxPadding);
        const center = bb.getCenter(new THREE.Vector3());

        const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
        const edges = new THREE.EdgesGeometry(geo);
        const mat = new THREE.LineBasicMaterial({
            color: color,
            transparent: true,
            opacity: CONFIG.boxOpacity,
            depthTest: false,
            depthWrite: false
        });
        const line = new THREE.LineSegments(edges, mat);
        line.renderOrder = 9999;
        line.frustumCulled = false;
        line.userData.__espOffset = center;
        geo.dispose();
        return line;
    }

    function positionBox(THREE, box, mesh) {
        const off = box.userData.__espOffset;
        box.position.copy(mesh.position);
        box.position.add(off.clone().applyQuaternion(mesh.quaternion));
        box.quaternion.copy(mesh.quaternion);
        box.scale.copy(mesh.scale);
    }

    // ---------- wireframe clone ----------
    function buildWire(THREE, mesh, color) {
        const clone = new THREE.Group();
        clone.renderOrder = 9998;
        clone.frustumCulled = false;
        mesh.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const mat = new THREE.MeshBasicMaterial({
                    color: color,
                    wireframe: true,
                    transparent: true,
                    opacity: CONFIG.wireOpacity,
                    depthTest: false,
                    depthWrite: false
                });
                const m = new THREE.Mesh(child.geometry, mat);
                m.renderOrder = 9998;
                m.frustumCulled = false;
                child.updateWorldMatrix(true, false);
                m.matrixAutoUpdate = false;
                m.matrix.copy(child.matrixWorld);
                clone.add(m);
            }
        });
        return clone;
    }

    // ---------- per-frame update ----------
    function updateESP(THREE) {
        if (!state.scene) return;
        if (!CONFIG.enabled) { teardownAll(); return; }

        const players = collectPlayers(THREE);
        const lteam = localTeam();
        const live = new Set();

        for (const mesh of players) {
            const id = mesh.uuid;
            live.add(id);

            const p = mesh.player || mesh.userData?.player;
            const isEnemy = lteam == null ? true : (p.team !== lteam);
            const color = isEnemy ? CONFIG.enemyColor : CONFIG.teamColor;

            let entry = state.espMap.get(id);
            if (!entry) {
                entry = { box: null, wire: null };
                state.espMap.set(id, entry);
            }

            // box
            if (CONFIG.box) {
                if (!entry.box) {
                    entry.box = buildBox(THREE, mesh, color);
                    state.scene.add(entry.box);
                } else {
                    entry.box.material.color.setHex(color);
                    entry.box.material.opacity = CONFIG.boxOpacity;
                }
                positionBox(THREE, entry.box, mesh);
            } else if (entry.box) {
                state.scene.remove(entry.box);
                entry.box.geometry?.dispose();
                entry.box.material?.dispose();
                entry.box = null;
            }

            // wire
            if (CONFIG.wireframe) {
                if (!entry.wire) {
                    entry.wire = buildWire(THREE, mesh, color);
                    state.scene.add(entry.wire);
                } else {
                    entry.wire.traverse((c) => {
                        if (c.isMesh) c.material.color.setHex(color);
                    });
                }
                entry.wire.position.copy(mesh.position);
                entry.wire.quaternion.copy(mesh.quaternion);
                entry.wire.scale.copy(mesh.scale);
            } else if (entry.wire) {
                disposeGroup(entry.wire);
                state.scene.remove(entry.wire);
                entry.wire = null;
            }
        }

        // cleanup dead players
        for (const [id, entry] of state.espMap) {
            if (!live.has(id)) {
                if (entry.box) {
                    state.scene.remove(entry.box);
                    entry.box.geometry?.dispose();
                    entry.box.material?.dispose();
                }
                if (entry.wire) {
                    disposeGroup(entry.wire);
                    state.scene.remove(entry.wire);
                }
                state.espMap.delete(id);
            }
        }
    }

    function disposeGroup(g) {
        g.traverse((c) => {
            if (c.isMesh) {
                c.geometry?.dispose?.();
                c.material?.dispose?.();
            }
        });
    }

    function teardownAll() {
        for (const [, entry] of state.espMap) {
            if (entry.box) {
                state.scene?.remove(entry.box);
                entry.box.geometry?.dispose();
                entry.box.material?.dispose();
            }
            if (entry.wire) {
                disposeGroup(entry.wire);
                state.scene?.remove(entry.wire);
            }
        }
        state.espMap.clear();
    }

    // ---------- hotkeys ----------
    function bindKeys() {
        document.addEventListener('keydown', (e) => {
            if (e.repeat) return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

            switch (e.code) {
                case CONFIG.hotkeys.master:
                    CONFIG.enabled = !CONFIG.enabled;
                    save(); refreshMenu();
                    break;
                case CONFIG.hotkeys.box:
                    CONFIG.box = !CONFIG.box;
                    save(); refreshMenu();
                    break;
                case CONFIG.hotkeys.wireframe:
                    CONFIG.wireframe = !CONFIG.wireframe;
                    save(); refreshMenu();
                    break;
                case CONFIG.hotkeys.menu:
                    toggleMenu();
                    break;
            }
        }, true);
    }

    // ---------- menu ----------
    function buildMenu() {
        const el = document.createElement('div');
        el.id = 'krunker-esp-menu';
        el.style.cssText = `
            position: fixed; top: 12px; right: 12px;
            background: rgba(8,10,12,0.92);
            color: #d8e0ea;
            font-family: ui-monospace, Menlo, Consolas, monospace;
            font-size: 12px; line-height: 1.5;
            padding: 12px 14px;
            border: 1px solid #2a3140;
            border-radius: 6px;
            z-index: 2147483647;
            width: 230px;
            user-select: none;
            box-shadow: 0 6px 24px rgba(0,0,0,0.55);
            display: none;
        `;

        el.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <span style="color:#7ee0a1;font-weight:600;letter-spacing:0.5px;">KRUNKER ESP</span>
                <span id="kesp-close" style="cursor:pointer;color:#8892a6;">x</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin:3px 0;">
                <span>Master [M]</span><span id="kesp-master">ON</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin:3px 0;">
                <span>Box [B]</span><span id="kesp-box">ON</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin:3px 0;">
                <span>Wireframe [V]</span><span id="kesp-wire">OFF</span>
            </div>
            <hr style="border:0;border-top:1px solid #2a3140;margin:8px 0;">
            <div style="display:flex;justify-content:space-between;margin:3px 0;">
                <span>Enemy</span><input type="color" id="kesp-c-enemy" style="width:36px;height:18px;border:0;background:none;">
            </div>
            <div style="display:flex;justify-content:space-between;margin:3px 0;">
                <span>Team</span><input type="color" id="kesp-c-team" style="width:36px;height:18px;border:0;background:none;">
            </div>
            <div style="margin:6px 0 2px 0;">Box opacity <span id="kesp-op-val">0.85</span></div>
            <input type="range" id="kesp-op" min="0.1" max="1" step="0.05" value="0.85" style="width:100%;">
            <div style="margin:6px 0 2px 0;">Wire opacity <span id="kesp-wop-val">0.50</span></div>
            <input type="range" id="kesp-wop" min="0.1" max="1" step="0.05" value="0.5" style="width:100%;">
            <hr style="border:0;border-top:1px solid #2a3140;margin:8px 0;">
            <div style="color:#8892a6;font-size:11px;">[N] toggle menu</div>
        `;

        document.body.appendChild(el);
        state.menuEl = el;

        const hex = (n) => '#' + n.toString(16).padStart(6, '0');
        const $ = (id) => el.querySelector(id);

        $('kesp-close').onclick = toggleMenu;
        $('kesp-c-enemy').value = hex(CONFIG.enemyColor);
        $('kesp-c-team').value = hex(CONFIG.teamColor);
        $('kesp-op').value = CONFIG.boxOpacity;
        $('kesp-wop').value = CONFIG.wireOpacity;
        $('kesp-op-val').textContent = CONFIG.boxOpacity.toFixed(2);
        $('kesp-wop-val').textContent = CONFIG.wireOpacity.toFixed(2);

        $('kesp-c-enemy').oninput = (e) => {
            CONFIG.enemyColor = parseInt(e.target.value.slice(1), 16);
            save();
        };
        $('kesp-c-team').oninput = (e) => {
            CONFIG.teamColor = parseInt(e.target.value.slice(1), 16);
            save();
        };
        $('kesp-op').oninput = (e) => {
            CONFIG.boxOpacity = parseFloat(e.target.value);
            $('kesp-op-val').textContent = CONFIG.boxOpacity.toFixed(2);
            save();
        };
        $('kesp-wop').oninput = (e) => {
            CONFIG.wireOpacity = parseFloat(e.target.value);
            $('kesp-wop-val').textContent = CONFIG.wireOpacity.toFixed(2);
            save();
        };

        refreshMenu();
    }

    function refreshMenu() {
        if (!state.menuEl) return;
        const set = (id, on) => {
            const n = state.menuEl.querySelector(id);
            if (n) { n.textContent = on ? 'ON' : 'OFF'; n.style.color = on ? '#7ee0a1' : '#8892a6'; }
        };
        set('#kesp-master', CONFIG.enabled);
        set('#kesp-box', CONFIG.box);
        set('#kesp-wire', CONFIG.wireframe);
    }

    function toggleMenu() {
        if (!state.menuEl) return;
        state.menuVisible = !state.menuVisible;
        state.menuEl.style.display = state.menuVisible ? 'block' : 'none';
    }

    // ---------- boot ----------
    function boot() {
        load();
        waitForThree((THREE) => {
            hookRenderer(THREE);
        });
        bindKeys();

        const iv = setInterval(() => {
            if (document.body) {
                clearInterval(iv);
                buildMenu();
            }
        }, 120);
    }

    boot();
})();
