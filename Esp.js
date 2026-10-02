// ==UserScript==
// @name         Krunker ESP
// @namespace    krunker-esp-local
// @version      1.1
// @description  Box ESP + Wireframe ESP for Krunker.io — no aimbot, no triggerbot, visual only
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
        espMap: new Map(),
        menuEl: null,
        menuVisible: false,
        refs: {}
    };

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

    function collectPlayers() {
        const list = [];
        if (!state.scene) return list;
        state.scene.traverse((o) => {
            if (isPlayerMesh(o)) list.push(o);
        });
        return list;
    }

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

    function positionBox(box, mesh) {
        const off = box.userData.__espOffset;
        box.position.copy(mesh.position);
        box.position.add(off.clone().applyQuaternion(mesh.quaternion));
        box.quaternion.copy(mesh.quaternion);
        box.scale.copy(mesh.scale);
    }

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

    function updateESP(THREE) {
        if (!state.scene) return;
        if (!CONFIG.enabled) { teardownAll(); return; }

        const players = collectPlayers();
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

    function makeRow(label, valueId, valueText) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;margin:3px 0;';
        const l = document.createElement('span');
        l.textContent = label;
        const v = document.createElement('span');
        v.id = valueId;
        v.textContent = valueText;
        row.appendChild(l);
        row.appendChild(v);
        return { row, value: v };
    }

    function buildMenu() {
        if (state.menuEl) return;

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

        // header
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;';
        const title = document.createElement('span');
        title.style.cssText = 'color:#7ee0a1;font-weight:600;letter-spacing:0.5px;';
        title.textContent = 'KRUNKER ESP';
        const close = document.createElement('span');
        close.style.cssText = 'cursor:pointer;color:#8892a6;';
        close.textContent = 'x';
        close.addEventListener('click', toggleMenu);
        header.appendChild(title);
        header.appendChild(close);
        el.appendChild(header);

        // toggles
        const masterRow = makeRow('Master [M]', 'kesp-master', 'ON');
        const boxRow = makeRow('Box [B]', 'kesp-box', 'ON');
        const wireRow = makeRow('Wireframe [V]', 'kesp-wire', 'OFF');
        el.appendChild(masterRow.row);
        el.appendChild(boxRow.row);
        el.appendChild(wireRow.row);

        // divider
        const hr1 = document.createElement('hr');
        hr1.style.cssText = 'border:0;border-top:1px solid #2a3140;margin:8px 0;';
        el.appendChild(hr1);

        // colors
        const enemyColorRow = document.createElement('div');
        enemyColorRow.style.cssText = 'display:flex;justify-content:space-between;margin:3px 0;align-items:center;';
        const enemyColorLbl = document.createElement('span');
        enemyColorLbl.textContent = 'Enemy';
        const enemyColorInput = document.createElement('input');
        enemyColorInput.type = 'color';
        enemyColorInput.style.cssText = 'width:36px;height:18px;border:0;background:none;';
        enemyColorInput.value = '#' + CONFIG.enemyColor.toString(16).padStart(6, '0');
        enemyColorInput.addEventListener('input', (e) => {
            CONFIG.enemyColor = parseInt(e.target.value.slice(1), 16);
            save();
        });
        enemyColorRow.appendChild(enemyColorLbl);
        enemyColorRow.appendChild(enemyColorInput);
        el.appendChild(enemyColorRow);

        const teamColorRow = document.createElement('div');
        teamColorRow.style.cssText = 'display:flex;justify-content:space-between;margin:3px 0;align-items:center;';
        const teamColorLbl = document.createElement('span');
        teamColorLbl.textContent = 'Team';
        const teamColorInput = document.createElement('input');
        teamColorInput.type = 'color';
        teamColorInput.style.cssText = 'width:36px;height:18px;border:0;background:none;';
        teamColorInput.value = '#' + CONFIG.teamColor.toString(16).padStart(6, '0');
        teamColorInput.addEventListener('input', (e) => {
            CONFIG.teamColor = parseInt(e.target.value.slice(1), 16);
            save();
        });
        teamColorRow.appendChild(teamColorLbl);
        teamColorRow.appendChild(teamColorInput);
        el.appendChild(teamColorRow);

        // box opacity
        const boxOpLabel = document.createElement('div');
        boxOpLabel.style.cssText = 'margin:6px 0 2px 0;';
        boxOpLabel.textContent = 'Box opacity ';
        const boxOpVal = document.createElement('span');
        boxOpVal.textContent = CONFIG.boxOpacity.toFixed(2);
        boxOpLabel.appendChild(boxOpVal);
        el.appendChild(boxOpLabel);

        const boxOpRange = document.createElement('input');
        boxOpRange.type = 'range';
        boxOpRange.min = '0.1';
        boxOpRange.max = '1';
        boxOpRange.step = '0.05';
        boxOpRange.value = CONFIG.boxOpacity;
        boxOpRange.style.width = '100%';
        boxOpRange.addEventListener('input', (e) => {
            CONFIG.boxOpacity = parseFloat(e.target.value);
            boxOpVal.textContent = CONFIG.boxOpacity.toFixed(2);
            save();
        });
        el.appendChild(boxOpRange);

        // wire opacity
        const wireOpLabel = document.createElement('div');
        wireOpLabel.style.cssText = 'margin:6px 0 2px 0;';
        wireOpLabel.textContent = 'Wire opacity ';
        const wireOpVal = document.createElement('span');
        wireOpVal.textContent = CONFIG.wireOpacity.toFixed(2);
        wireOpLabel.appendChild(wireOpVal);
        el.appendChild(wireOpLabel);

        const wireOpRange = document.createElement('input');
        wireOpRange.type = 'range';
        wireOpRange.min = '0.1';
        wireOpRange.max = '1';
        wireOpRange.step = '0.05';
        wireOpRange.value = CONFIG.wireOpacity;
        wireOpRange.style.width = '100%';
        wireOpRange.addEventListener('input', (e) => {
            CONFIG.wireOpacity = parseFloat(e.target.value);
            wireOpVal.textContent = CONFIG.wireOpacity.toFixed(2);
            save();
        });
        el.appendChild(wireOpRange);

        // divider
        const hr2 = document.createElement('hr');
        hr2.style.cssText = 'border:0;border-top:1px solid #2a3140;margin:8px 0;';
        el.appendChild(hr2);

        // footer
        const footer = document.createElement('div');
        footer.style.cssText = 'color:#8892a6;font-size:11px;';
        footer.textContent = '[N] toggle menu';
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

    function boot() {
        load();
        waitForThree((THREE) => {
            hookRenderer(THREE);
        });
        bindKeys();

        // menu só depois que o body existir
        const iv = setInterval(() => {
            if (document.body) {
                clearInterval(iv);
                try {
                    buildMenu();
                    console.log('[Krunker ESP] loaded');
                } catch (e) {
                    console.error('[Krunker ESP] menu error:', e);
                }
            }
        }, 200);
    }

    boot();
})();
