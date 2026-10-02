// ==UserScript==
// @name         Krunker ESP
// @namespace    krunker-esp-local
// @version      2.0
// @description  Box ESP + Wireframe ESP for Krunker.io
// @author       Kovak
// @match        *://krunker.io/*
// @match        *://*.krunker.io/*
// @grant        none
// @run-at       document-end
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
        boxPadding: 1.15,
        hotkeys: { master: 'KeyM', box: 'KeyB', wireframe: 'KeyV', menu: 'KeyN' }
    };

    const state = {
        scene: null,
        camera: null,
        renderer: null,
        THREE: null,
        espMap: new Map(),
        menuEl: null,
        menuVisible: false,
        refs: {},
        lastPlayerCount: -1
    };

    function log(...a) { console.log('[ESP]', ...a); }
    function warn(...a) { console.warn('[ESP]', ...a); }

    function load() {
        try {
            const raw = localStorage.getItem('krunker-esp-cfg');
            if (raw) Object.assign(CONFIG, JSON.parse(raw));
        } catch (_) {}
    }
    function save() {
        try { localStorage.setItem('krunker-esp-cfg', JSON.stringify(CONFIG)); } catch (_) {}
    }

    // ---------- STRATEGY 1: hook getContext to capture renderer ----------
    function hookGetContext() {
        const orig = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
            const ctx = orig.call(this, type, ...args);
            if (type && type.startsWith('webgl') && ctx && !ctx.__espHooked) {
                ctx.__espHooked = true;
                ctx.__espCanvas = this;
                log('WebGL context captured on canvas', this.width, 'x', this.height);
            }
            return ctx;
        };
    }

    // ---------- STRATEGY 2: scan window for THREE ----------
    function findTHREE() {
        if (state.THREE) return state.THREE;

        // direct
        if (window.THREE && window.THREE.WebGLRenderer) {
            state.THREE = window.THREE;
            log('THREE found at window.THREE');
            return state.THREE;
        }

        // scan window keys
        for (const k of Object.keys(window)) {
            try {
                const v = window[k];
                if (v && typeof v === 'object' && v.WebGLRenderer && v.Scene && v.Mesh) {
                    state.THREE = v;
                    log('THREE found at window.' + k);
                    return state.THREE;
                }
            } catch (_) {}
        }

        // webpack module cache
        try {
            const chunks = window.webpackChunk || window.webpackChunkkrunker || [];
            for (const chunk of chunks) {
                const modules = chunk[1] || {};
                for (const id in modules) {
                    try {
                        const mod = modules[id];
                        if (typeof mod !== 'function') continue;
                        const exports = mod.exports || (mod.exports = {});
                        if (exports.WebGLRenderer && exports.Scene && exports.Mesh) {
                            state.THREE = exports;
                            log('THREE found in webpack module', id);
                            return state.THREE;
                        }
                    } catch (_) {}
                }
            }
        } catch (_) {}

        return null;
    }

    // ---------- STRATEGY 3: hook WebGLRenderer.prototype.render once THREE found ----------
    function hookRenderer(THREE) {
        const proto = THREE.WebGLRenderer.prototype;
        if (proto.__espHooked) return;
        proto.__espHooked = true;
        const orig = proto.render;
        proto.render = function (sc, cam) {
            state.scene = sc;
            state.camera = cam;
            state.renderer = this;
            try { updateESP(THREE); } catch (e) { warn('update error:', e.message); }
            return orig.apply(this, arguments);
        };
        log('WebGLRenderer.render hooked');
    }

    // ---------- STRATEGY 4: scan scene for player-like objects ----------
    function isPlayerLike(obj) {
        if (!obj || !obj.isObject3D) return false;
        const p = obj.player || obj.userData?.player || obj.entity || obj.userData?.entity;
        if (!p) return false;
        if (p.active === false) return false;
        if (p.isYou === true || p.isLocal === true) return false;
        return true;
    }

    function isLikelyPlayerMesh(obj) {
        // fallback: any SkinnedMesh or Mesh with a health-like property
        if (!obj || !obj.isObject3D) return false;
        if (obj.isSkinnedMesh) return true;
        return false;
    }

    function localTeam() {
        const lp = window.localPlayer || window.me || window.game?.localPlayer || window.game?.me;
        return lp?.team ?? lp?.side ?? null;
    }

    function collectPlayers() {
        const list = [];
        if (!state.scene) return list;
        state.scene.traverse((o) => {
            if (isPlayerLike(o)) list.push({ mesh: o, player: o.player || o.userData?.player || o.entity });
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
            color, transparent: true, opacity: CONFIG.boxOpacity,
            depthTest: false, depthWrite: false
        });
        const line = new THREE.LineSegments(edges, mat);
        line.renderOrder = 9999;
        line.frustumCulled = false;
        line.userData.__espOffset = center;
        geo.dispose();
        return line;
    }

    function positionBox(box, mesh) {
        const off = box.userData.__espOffset;
        box.position.copy(mesh.position);
        box.position.add(off.clone().applyQuaternion(mesh.quaternion));
        box.quaternion.copy(mesh.quaternion);
        box.scale.copy(mesh.scale);
    }

    // ---------- wireframe ----------
    function buildWire(THREE, mesh, color) {
        const clone = new THREE.Group();
        clone.renderOrder = 9998;
        clone.frustumCulled = false;
        mesh.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const mat = new THREE.MeshBasicMaterial({
                    color, wireframe: true, transparent: true,
                    opacity: CONFIG.wireOpacity, depthTest: false, depthWrite: false
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

    function disposeGroup(g) {
        g.traverse((c) => {
            if (c.isMesh) { c.geometry?.dispose?.(); c.material?.dispose?.(); }
        });
    }

    // ---------- main update ----------
    function updateESP(THREE) {
        if (!state.scene) return;
        if (!CONFIG.enabled) { teardownAll(); return; }

        const players = collectPlayers();
        if (players.length !== state.lastPlayerCount) {
            log('players found:', players.length);
            state.lastPlayerCount = players.length;
        }

        const lteam = localTeam();
        const live = new Set();

        for (const { mesh, player } of players) {
            const id = mesh.uuid;
            live.add(id);

            const isEnemy = lteam == null ? true : (player.team !== lteam);
            const color = isEnemy ? CONFIG.enemyColor : CONFIG.teamColor;

            let entry = state.espMap.get(id);
            if (!entry) { entry = { box: null, wire: null }; state.espMap.set(id, entry); }

            if (CONFIG.box) {
                if (!entry.box) {
                    entry.box = buildBox(THREE, mesh, color);
                    state.scene.add(entry.box);
                } else {
                    entry.box.material.color.setHex(color);
                    entry.box.material.opacity = CONFIG.boxOpacity;
                }
                positionBox(entry.box, mesh);
            } else if (entry.box) {
                state.scene.remove(entry.box);
                entry.box.geometry?.dispose();
                entry.box.material?.dispose();
                entry.box = null;
            }

            if (CONFIG.wireframe) {
                if (!entry.wire) {
                    entry.wire = buildWire(THREE, mesh, color);
                    state.scene.add(entry.wire);
                } else {
                    entry.wire.traverse((c) => { if (c.isMesh) c.material.color.setHex(color); });
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

    function teardownAll() {
        for (const [, entry] of state.espMap) {
            if (entry.box) { state.scene?.remove(entry.box); entry.box.geometry?.dispose(); entry.box.material?.dispose(); }
            if (entry.wire) { disposeGroup(entry.wire); state.scene?.remove(entry.wire); }
        }
        state.espMap.clear();
    }

    // ---------- debug ----------
    window.__espDebug = {
        log() {
            console.log('=== ESP DEBUG ===');
            console.log('THREE:', state.THREE ? 'found' : 'NOT FOUND');
            console.log('scene:', state.scene ? state.scene.type + ' (' + state.scene.children.length + ' children)' : 'null');
            console.log('camera:', state.camera ? state.camera.type : 'null');
            console.log('renderer:', state.renderer ? 'captured' : 'null');
            console.log('espMap size:', state.espMap.size);
            console.log('--- scene children ---');
            if (state.scene) {
                state.scene.children.slice(0, 30).forEach((c, i) => {
                    console.log(i, c.type, c.name || '(no name)', 'children:', c.children?.length || 0,
                        'isSkinnedMesh:', !!c.isSkinnedMesh, 'player:', !!(c.player || c.userData?.player));
                });
            }
            console.log('--- window keys with player/entity ---');
            Object.keys(window).forEach(k => {
                try {
                    const v = window[k];
                    if (v && typeof v === 'object' && (v.players || v.entities)) {
                        console.log('window.' + k, '-> players:', v.players?.length, 'entities:', v.entities?.length);
                    }
                } catch (_) {}
            });
        },
        findPlayers() {
            const list = collectPlayers();
            console.log('found', list.length, 'players');
            list.forEach(({ mesh, player }) => {
                console.log(mesh.uuid, mesh.type, 'pos:', mesh.position.toArray(), 'player keys:', Object.keys(player || {}));
            });
        },
        dump(obj) {
            const o = obj || state.scene;
            if (!o) return console.log('nothing to dump');
            console.log('dumping', o.type, o.name);
            o.traverse((c) => {
                if (c.isMesh || c.isSkinnedMesh || c.isGroup) {
                    console.log(c.type, c.name, 'children:', c.children.length, 'keys:', Object.keys(c).slice(0, 10));
                }
            });
        }
    };

    // ---------- hotkeys ----------
    function bindKeys() {
        document.addEventListener('keydown', (e) => {
            if (e.repeat) return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
            switch (e.code) {
                case CONFIG.hotkeys.master:
                    CONFIG.enabled = !CONFIG.enabled; save(); refreshMenu(); break;
                case CONFIG.hotkeys.box:
                    CONFIG.box = !CONFIG.box; save(); refreshMenu(); break;
                case CONFIG.hotkeys.wireframe:
                    CONFIG.wireframe = !CONFIG.wireframe; save(); refreshMenu(); break;
                case CONFIG.hotkeys.menu:
                    toggleMenu(); break;
            }
        }, true);
    }

    // ---------- menu ----------
    function makeRow(label, valueId, valueText) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;margin:3px 0;';
        const l = document.createElement('span'); l.textContent = label;
        const v = document.createElement('span'); v.id = valueId; v.textContent = valueText;
        row.appendChild(l); row.appendChild(v);
        return { row, value: v };
    }

    function buildMenu() {
        if (state.menuEl) return;
        const el = document.createElement('div');
        el.id = 'krunker-esp-menu';
        el.style.cssText = `
            position: fixed; top: 12px; right: 12px;
            background: rgba(8,10,12,0.92); color: #d8e0ea;
            font-family: ui-monospace, Menlo, Consolas, monospace;
            font-size: 12px; line-height: 1.5;
            padding: 12px 14px; border: 1px solid #2a3140; border-radius: 6px;
            z-index: 2147483647; width: 230px; user-select: none;
            box-shadow: 0 6px 24px rgba(0,0,0,0.55); display: none;
        `;
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;';
        const title = document.createElement('span');
        title.style.cssText = 'color:#7ee0a1;font-weight:600;letter-spacing:0.5px;';
        title.textContent = 'KRUNKER ESP';
        const close = document.createElement('span');
        close.style.cssText = 'cursor:pointer;color:#8892a6;';
        close.textContent = 'x';
        close.addEventListener('click', toggleMenu);
        header.appendChild(title); header.appendChild(close); el.appendChild(header);

        const masterRow = makeRow('Master [M]', 'kesp-master', 'ON');
        const boxRow = makeRow('Box [B]', 'kesp-box', 'ON');
        const wireRow = makeRow('Wireframe [V]', 'kesp-wire', 'OFF');
        el.appendChild(masterRow.row); el.appendChild(boxRow.row); el.appendChild(wireRow.row);

        const hr1 = document.createElement('hr');
        hr1.style.cssText = 'border:0;border-top:1px solid #2a3140;margin:8px 0;';
        el.appendChild(hr1);

        const eRow = document.createElement('div');
        eRow.style.cssText = 'display:flex;justify-content:space-between;margin:3px 0;align-items:center;';
        const eLbl = document.createElement('span'); eLbl.textContent = 'Enemy';
        const eIn = document.createElement('input'); eIn.type = 'color';
        eIn.style.cssText = 'width:36px;height:18px;border:0;background:none;';
        eIn.value = '#' + CONFIG.enemyColor.toString(16).padStart(6, '0');
        eIn.addEventListener('input', (e) => { CONFIG.enemyColor = parseInt(e.target.value.slice(1), 16); save(); });
        eRow.appendChild(eLbl); eRow.appendChild(eIn); el.appendChild(eRow);

        const tRow = document.createElement('div');
        tRow.style.cssText = 'display:flex;justify-content:space-between;margin:3px 0;align-items:center;';
        const tLbl = document.createElement('span'); tLbl.textContent = 'Team';
        const tIn = document.createElement('input'); tIn.type = 'color';
        tIn.style.cssText = 'width:36px;height:18px;border:0;background:none;';
        tIn.value = '#' + CONFIG.teamColor.toString(16).padStart(6, '0');
        tIn.addEventListener('input', (e) => { CONFIG.teamColor = parseInt(e.target.value.slice(1), 16); save(); });
        tRow.appendChild(tLbl); tRow.appendChild(tIn); el.appendChild(tRow);

        const opLabel = document.createElement('div');
        opLabel.style.cssText = 'margin:6px 0 2px 0;';
        opLabel.textContent = 'Box opacity ';
        const opVal = document.createElement('span'); opVal.textContent = CONFIG.boxOpacity.toFixed(2);
        opLabel.appendChild(opVal); el.appendChild(opLabel);
        const opRange = document.createElement('input');
        opRange.type = 'range'; opRange.min = '0.1'; opRange.max = '1'; opRange.step = '0.05';
        opRange.value = CONFIG.boxOpacity; opRange.style.width = '100%';
        opRange.addEventListener('input', (e) => { CONFIG.boxOpacity = parseFloat(e.target.value); opVal.textContent = CONFIG.boxOpacity.toFixed(2); save(); });
        el.appendChild(opRange);

        const hr2 = document.createElement('hr');
        hr2.style.cssText = 'border:0;border-top:1px solid #2a3140;margin:8px 0;';
        el.appendChild(hr2);

        const footer = document.createElement('div');
        footer.style.cssText = 'color:#8892a6;font-size:11px;';
        footer.innerHTML = '[N] menu &nbsp; [B] box &nbsp; [V] wire<br>Debug: <code>__espDebug.log()</code>';
        el.appendChild(footer);

        document.body.appendChild(el);
        state.menuEl = el;
        state.refs.master = masterRow.value;
        state.refs.box = boxRow.value;
        state.refs.wire = wireRow.value;
        refreshMenu();
    }

    function refreshMenu() {
        const set = (node, on) => {
            if (!node) return;
            node.textContent = on ? 'ON' : 'OFF';
            node.style.color = on ? '#7ee0a1' : '#8892a6';
        };
        set(state.refs.master, CONFIG.enabled);
        set(state.refs.box, CONFIG.box);
        set(state.refs.wire, CONFIG.wireframe);
    }

    function toggleMenu() {
        if (!state.menuEl) return;
        state.menuVisible = !state.menuVisible;
        state.menuEl.style.display = state.menuVisible ? 'block' : 'none';
    }

    // ---------- boot ----------
    function boot() {
        load();
        hookGetContext();
        bindKeys();

        const iv = setInterval(() => {
            if (document.body) { clearInterval(iv); buildMenu(); }
        }, 200);

        // try to find THREE every 500ms
        const threeIv = setInterval(() => {
            const THREE = findTHREE();
            if (THREE) {
                clearInterval(threeIv);
                hookRenderer(THREE);
                log('hook installed, waiting for scene...');
            }
        }, 500);

        // fallback: also try rAF-based scene detection
        let rafFrame = 0;
        function rafLoop() {
            rafFrame++;
            if (!state.scene && state.THREE && rafFrame % 60 === 0) {
                // try to find scene in window
                for (const k of Object.keys(window)) {
                    try {
                        const v = window[k];
                        if (v && v.isScene && v.children) { state.scene = v; log('scene found via rAF at window.' + k); break; }
                    } catch (_) {}
                }
            }
            requestAnimationFrame(rafLoop);
        }
        requestAnimationFrame(rafLoop);

        log('booted');
    }

    boot();
})();
