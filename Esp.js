  // ==UserScript==
  // @name         Krunker.io ESP
  // @namespace    krunker-esp-v1
  // @version      1.0.0
  // @description  Box ESP + Wireframe ESP for Krunker.io
  // @author       anon
  // @match        *://krunker.io/*
  // @match        *://*.krunker.io/*
  // @grant        none
  // @run-at       document-start
  // ==/UserScript==

  (function() {
      'use strict';

      // CONFIG
      const CONFIG = {
          masterEnabled: true,
          boxEnabled: true,
          wireframeEnabled: false,
          enemyColor: 0xff0000,
          teamColor: 0x00ff00,
          boxThickness: 2,
          boxOpacity: 0.8,
          wireframeOpacity: 0.6,
          hotkeys: {
              master: 'KeyM',
              box: 'KeyB',
              wireframe: 'KeyV',
              menu: 'KeyN'
          }
      };

      // STATE
      let scene = null;
      let camera = null;
      let renderer = null;
      let espObjects = new Map(); // playerId -> { box, wireframe,
  mesh }
      let originalMaterials = new WeakMap(); // mesh -> original
  material
      let menuEl = null;
      let menuVisible = false;
      let hooked = false;

      // SETTINGS PERSISTENCE
      function loadSettings() {
          try {
              const saved =
  localStorage.getItem('krunker-esp-config');
              if (saved) {
                  const parsed = JSON.parse(saved);
                  Object.assign(CONFIG, parsed);
              }
          } catch (e) {
              console.warn('[Krunker ESP] Failed to load
  settings:', e);
          }
      }

      function saveSettings() {
          try {
              localStorage.setItem('krunker-esp-config',
  JSON.stringify(CONFIG));
          } catch (e) {
              console.warn('[Krunker ESP] Failed to save
  settings:', e);
          }
      }

      // HOOK THREE.JS RENDERER
      function hookRenderer() {
          if (hooked) return;
          const checkThree = setInterval(() => {
              if (typeof THREE !== 'undefined' &&
  THREE.WebGLRenderer) {
                  clearInterval(checkThree);
                  const originalRender =
  THREE.WebGLRenderer.prototype.render;
                  THREE.WebGLRenderer.prototype.render =
  function(sceneArg, cameraArg, ...rest) {
                      scene = sceneArg;
                      camera = cameraArg;
                      renderer = this;
                      if (CONFIG.masterEnabled) {
                          updateESP();
                      }
                      return originalRender.call(this, sceneArg,
  cameraArg, ...rest);
                  };
                  hooked = true;
                  console.log('[Krunker ESP] Renderer hooked');
              }
          }, 100);
      }

      // FIND PLAYERS IN SCENE
      function findPlayers() {
          if (!scene) return [];
          const players = [];
          const localPlayer = getLocalPlayer();

          scene.traverse(obj => {
              // Krunker player meshes have a .player property or
  are part of player objects
              // Adjust this check based on actual Krunker
  structure
              if (obj.isMesh && obj.player && obj.player.active &&
  !obj.player.isYou) {
                  const isEnemy = localPlayer ? obj.player.team !==
  localPlayer.team : true;
                  players.push({
                      mesh: obj,
                      player: obj.player,
                      isEnemy,
                      id: obj.player.id || obj.uuid
                  });
              }
          });
          return players;
      }

      // GET LOCAL PLAYER
      function getLocalPlayer() {
          // Krunker stores local player in window.me or similar
          // Adjust based on actual game structure
          if (typeof window.me !== 'undefined') return window.me;
          if (typeof window.localPlayer !== 'undefined') return
  window.localPlayer;
          return null;
      }

      // CREATE BOX ESP
      function createBox(mesh, isEnemy) {
          const box = new THREE.Box3().setFromObject(mesh);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());

          const boxGeo = new THREE.BoxGeometry(size.x, size.y,
  size.z);
          const edges = new THREE.EdgesGeometry(boxGeo);
          const color = isEnemy ? CONFIG.enemyColor :
  CONFIG.teamColor;
          const mat = new THREE.LineBasicMaterial({
              color: color,
              linewidth: CONFIG.boxThickness,
              transparent: true,
              opacity: CONFIG.boxOpacity,
              depthTest: false,
              depthWrite: false
          });
          const line = new THREE.LineSegments(edges, mat);
          line.position.copy(center);
          line.renderOrder = 999;
          return line;
      }

      // CREATE WIREFRAME ESP
      function createWireframe(mesh, isEnemy) {
          const color = isEnemy ? CONFIG.enemyColor :
  CONFIG.teamColor;

          // Clone and apply wireframe material
          const applyWireframe = (obj) => {
              if (obj.isMesh && obj.geometry) {
                  if (!originalMaterials.has(obj)) {
                      originalMaterials.set(obj, obj.material);
                  }
                  const wireMat = new THREE.MeshBasicMaterial({
                      color: color,
                      wireframe: true,
                      transparent: true,
                      opacity: CONFIG.wireframeOpacity,
                      depthTest: false,
                      depthWrite: false
                  });
                  obj.material = wireMat;
                  obj.renderOrder = 998;
              }
          };

          mesh.traverse(applyWireframe);
          return mesh;
      }

      // RESTORE ORIGINAL MATERIALS
      function restoreOriginalMaterial(mesh) {
          mesh.traverse(obj => {
              if (obj.isMesh && originalMaterials.has(obj)) {
                  obj.material = originalMaterials.get(obj);
                  originalMaterials.delete(obj);
              }
          });
      }

      // UPDATE ESP EVERY FRAME
      function updateESP() {
          if (!scene) return;

          const players = findPlayers();
          const currentIds = new Set(players.map(p => p.id));

          // Remove ESP for players no longer present
          for (const [id, obj] of espObjects) {
              if (!currentIds.has(id)) {
                  if (obj.box) scene.remove(obj.box);
                  if (obj.wireframe)
  restoreOriginalMaterial(obj.mesh);
                  espObjects.delete(id);
              }
          }

          // Add/update ESP for current players
          for (const { mesh, player, isEnemy, id } of players) {
              let obj = espObjects.get(id);

              if (!obj) {
                  obj = { box: null, wireframe: false, mesh: mesh
  };
                  espObjects.set(id, obj);
              }

              // Update box ESP
              if (CONFIG.boxEnabled) {
                  if (obj.box) scene.remove(obj.box);
                  obj.box = createBox(mesh, isEnemy);
                  scene.add(obj.box);
              } else if (obj.box) {
                  scene.remove(obj.box);
                  obj.box = null;
              }

              // Update wireframe ESP
              if (CONFIG.wireframeEnabled) {
                  if (!obj.wireframe) {
                      createWireframe(mesh, isEnemy);
                      obj.wireframe = true;
                  }
              } else if (obj.wireframe) {
                  restoreOriginalMaterial(mesh);
                  obj.wireframe = false;
              }
          }
      }

      // HOTKEY HANDLING
      function setupHotkeys() {
          document.addEventListener('keydown', e => {
              // Master toggle
              if (e.code === CONFIG.hotkeys.master) {
                  CONFIG.masterEnabled = !CONFIG.masterEnabled;
                  if (!CONFIG.masterEnabled) {
                      clearAllESP();
                  }
                  saveSettings();
                  updateMenuStatus();
                  e.preventDefault();
              }

              // Box toggle
              if (e.code === CONFIG.hotkeys.box) {
                  CONFIG.boxEnabled = !CONFIG.boxEnabled;
                  saveSettings();
                  updateMenuStatus();
                  e.preventDefault();
              }

              // Wireframe toggle
              if (e.code === CONFIG.hotkeys.wireframe) {
                  CONFIG.wireframeEnabled =
  !CONFIG.wireframeEnabled;
                  saveSettings();
                  updateMenuStatus();
                  e.preventDefault();
              }

              // Menu toggle
              if (e.code === CONFIG.hotkeys.menu) {
                  toggleMenu();
                  e.preventDefault();
              }
          });
      }

      // CLEAR ALL ESP OBJECTS
      function clearAllESP() {
          for (const [id, obj] of espObjects) {
              if (obj.box) scene.remove(obj.box);
              if (obj.wireframe) restoreOriginalMaterial(obj.mesh);
          }
          espObjects.clear();
      }

      // CREATE MENU OVERLAY
      function createMenu() {
          menuEl = document.createElement('div');
          menuEl.id = 'krunker-esp-menu';
          menuEl.style.cssText = `
              position: fixed;
              top: 10px;
              right: 10px;
              background: rgba(0, 0, 0, 0.9);
              color: #fff;
              font-family: 'Courier New', monospace;
              font-size: 13px;
              padding: 15px;
              border: 2px solid #00ff00;
              border-radius: 4px;
              z-index: 999999;
              display: none;
              user-select: none;
              box-shadow: 0 4px 12px rgba(0,0,0,0.5);
              min-width: 280px;
          `;

          menuEl.innerHTML = `
              <div style="margin-bottom: 12px; color: #00ff00;
  font-weight: bold; font-size: 14px; border-bottom: 1px solid
  #00ff00; padding-bottom: 8px;">
                  KRUNKER ESP v1.0
              </div>
              <div style="margin: 8px 0;">
                  <label style="display: inline-block; width:
  120px;">Master ESP:</label>
                  <span id="esp-master-status" style="color: #0f0;
  font-weight: bold;">ON</span>
                  <span style="color: #888; margin-left:
  8px;">[M]</span>
              </div>
              <div style="margin: 8px 0;">
                  <label style="display: inline-block; width:
  120px;">Box ESP:</label>
                  <span id="esp-box-status" style="color: #0f0;
  font-weight: bold;">ON</span>
                  <span style="color: #888; margin-left:
  8px;">[B]</span>
              </div>
              <div style="margin: 8px 0;">
                  <label style="display: inline-block; width:
  120px;">Wireframe:</label>
                  <span id="esp-wf-status" style="color: #f00;
  font-weight: bold;">OFF</span>
                  <span style="color: #888; margin-left:
  8px;">[V]</span>
              </div>
              <div style="border-top: 1px solid #444; margin: 12px
  0; padding-top: 12px;">
                  <div style="margin: 8px 0;">
                      <label style="display: block; margin-bottom:
  4px;">Enemy Color:</label>
                      <input type="color" id="esp-enemy-color"
  value="#ff0000" style="width: 60px; height: 30px; border: none;
  cursor: pointer;">
                  </div>
                  <div style="margin: 8px 0;">
                      <label style="display: block; margin-bottom:
  4px;">Team Color:</label>
                      <input type="color" id="esp-team-color"
  value="#00ff00" style="width: 60px; height: 30px; border: none;
  cursor: pointer;">
                  </div>
                  <div style="margin: 8px 0;">
                      <label style="display: block; margin-bottom:
  4px;">Box Thickness: <span id="thickness-val">2</span></label>
                      <input type="range" id="esp-thickness"
  min="1" max="10" value="2" style="width: 100%; cursor: pointer;">
                  </div>
                  <div style="margin: 8px 0;">
                      <label style="display: block; margin-bottom:
  4px;">Box Opacity: <span id="opacity-val">0.8</span></label>
                      <input type="range" id="esp-opacity"
  min="0.1" max="1" step="0.1" value="0.8" style="width: 100%;
  cursor: pointer;">
                  </div>
              </div>
              <div style="margin-top: 12px; padding-top: 8px;
  border-top: 1px solid #444; color: #888; font-size: 11px;">
                  Press [N] to toggle menu
              </div>
          `;

          document.body.appendChild(menuEl);
          bindMenuInputs();
      }

      // BIND MENU INPUTS
      function bindMenuInputs() {
          const enemyColorInput =
  document.getElementById('esp-enemy-color');
          const teamColorInput =
  document.getElementById('esp-team-color');
          const thicknessInput =
  document.getElementById('esp-thickness');
          const opacityInput =
  document.getElementById('esp-opacity');
          const thicknessVal =
  document.getElementById('thickness-val');
          const opacityVal =
  document.getElementById('opacity-val');

          if (enemyColorInput) {
              enemyColorInput.value = '#' +
  CONFIG.enemyColor.toString(16).padStart(6, '0');
              enemyColorInput.oninput = e => {
                  CONFIG.enemyColor =
  parseInt(e.target.value.slice(1), 16);
                  saveSettings();
              };
          }

          if (teamColorInput) {
              teamColorInput.value = '#' +
  CONFIG.teamColor.toString(16).padStart(6, '0');
              teamColorInput.oninput = e => {
                  CONFIG.teamColor =
  parseInt(e.target.value.slice(1), 16);
                  saveSettings();
              };
          }

          if (thicknessInput && thicknessVal) {
              thicknessInput.value = CONFIG.boxThickness;
              thicknessVal.textContent = CONFIG.boxThickness;
              thicknessInput.oninput = e => {
                  CONFIG.boxThickness = parseInt(e.target.value);
                  thicknessVal.textContent = CONFIG.boxThickness;
                  saveSettings();
              };
          }

          if (opacityInput && opacityVal) {
              opacityInput.value = CONFIG.boxOpacity;
              opacityVal.textContent = CONFIG.boxOpacity;
              opacityInput.oninput = e => {
                  CONFIG.boxOpacity = parseFloat(e.target.value);
                  opacityVal.textContent =
  CONFIG.boxOpacity.toFixed(1);
                  saveSettings();
              };
          }
      }

      // UPDATE MENU STATUS
      function updateMenuStatus() {
          const masterStatus =
  document.getElementById('esp-master-status');
          const boxStatus =
  document.getElementById('esp-box-status');
          const wfStatus =
  document.getElementById('esp-wf-status');

          if (masterStatus) {
              masterStatus.textContent = CONFIG.masterEnabled ?
  'ON' : 'OFF';
              masterStatus.style.color = CONFIG.masterEnabled ?
  '#0f0' : '#f00';
          }
          if (boxStatus) {
              boxStatus.textContent = CONFIG.boxEnabled ? 'ON' :
  'OFF';
              boxStatus.style.color = CONFIG.boxEnabled ? '#0f0' :
  '#f00';
          }
          if (wfStatus) {
              wfStatus.textContent = CONFIG.wireframeEnabled ? 'ON'
  : 'OFF';
              wfStatus.style.color = CONFIG.wireframeEnabled ?
  '#0f0' : '#f00';
          }
      }

      // TOGGLE MENU
      function toggleMenu() {
          menuVisible = !menuVisible;
          if (menuEl) {
              menuEl.style.display = menuVisible ? 'block' :
  'none';
          }
      }

      // INIT
      function init() {
          loadSettings();
          hookRenderer();
          setupHotkeys();

          const checkBody = setInterval(() => {
              if (document.body) {
                  clearInterval(checkBody);
                  createMenu();
                  updateMenuStatus();
              }
          }, 100);

          console.log('[Krunker ESP] Loaded successfully');
          console.log('[Krunker ESP] Hotkeys: [M] Master | [B] Box
  | [V] Wireframe | [N] Menu');
      }

      init();
  })();
