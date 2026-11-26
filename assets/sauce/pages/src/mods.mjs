// Written for Zluggish (not part of Sauce for Zwift): the page that lists, installs and enables the mods of the
// Overlay. Everything that comes from the server (mod manifests, store entries) is put into the page with
// `textContent` and `setAttribute`, never as HTML.
import * as Common from './common.mjs';

const rpc = Common.rpc;
let admin = false;
let lastModNote = '';

function el(tag, {className, text, attrs}={}, ...children) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text != null) {
        node.textContent = text;
    }
    for (const [k, v] of Object.entries(attrs || {})) {
        node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
}


function icon(name) {
    return el('ms', {text: name});
}


function button(label, iconName, onClick, className='') {
    const b = el('button', {className, attrs: {type: 'button'}}, icon(iconName), document.createTextNode(` ${label}`));
    b.addEventListener('click', onClick);
    return b;
}


function showError(message) {
    const box = document.querySelector('.mod-errors');
    box.textContent = message;
    box.hidden = false;
    setTimeout(() => {
        box.hidden = true;
        box.textContent = '';
    }, 8000);
}


function compareVersions(a, b) {
    const pa = String(a || '').split('.');
    const pb = String(b || '').split('.');
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = parseInt(pa[i], 10);
        const nb = parseInt(pb[i], 10);
        if (isNaN(na) || isNaN(nb)) {
            const sa = String(pa[i] || '');
            const sb = String(pb[i] || '');
            if (sa !== sb) {
                return sa < sb ? -1 : 1;
            }
            continue;
        }
        if (na !== nb) {
            return na < nb ? -1 : 1;
        }
    }
    return 0;
}


function storeEntryOf(manifest) {
    const name = String(manifest?.name || '').trim().toLowerCase();
    if (!name) {
        return null;
    }
    return storeMods.find(m => String(m.name || '').trim().toLowerCase() === name) || null;
}


function newestRelease(entry) {
    let best = null;
    for (const r of (entry && entry.releases) || []) {
        if (!best || compareVersions(r.version, best.version) > 0 ||
            (compareVersions(r.version, best.version) === 0 && (r.updated || 0) > (best.updated || 0))) {
            best = r;
        }
    }
    return best;
}


function refreshAfterModChange() {
    renderMods();
}


function statusLabel(mod) {
    if (mod.error) {
        return ['invalid', 'Invalid'];
    }
    if (mod.changed) {
        return ['changed', 'Changed since approval, off'];
    }
    return mod.enabled ? ['active', 'Enabled'] : ['disabled', 'Disabled'];
}


function modRow(mod) {
    const manifest = mod.manifest || {};
    const [statusClass, statusText] = statusLabel(mod);
    const head = el('div', {className: 'head'},
                    el('span', {className: 'name', text: manifest.name || mod.id}),
                    el('span', {className: 'version', text: manifest.version ? `v${manifest.version}` : ''}),
                    el('span', {className: `status ${statusClass}`, text: statusText}));
    const lines = [head];
    if (manifest.description) {
        lines.push(el('div', {className: 'desc', text: manifest.description}));
    }
    if (manifest.author) {
        lines.push(el('div', {className: 'meta', text: `By ${manifest.author}`}));
    }
    if (mod.error) {
        lines.push(el('div', {className: 'error', text: mod.error}));
    }
    const actions = el('div', {className: 'actions'});
    const row = el('div', {className: 'mod'});
    if (admin) {
        const confirmBox = el('div', {className: 'confirm', attrs: {hidden: ''}},
                              el('span', {text: 'This mod will run as code inside your Overlay, with your session. '}));
        const refresh = () => refreshAfterModChange();
        if (!mod.error) {
            const network = el('input', {attrs: {type: 'checkbox'}});
            network.checked = mod.network === true;
            const networkLabel = el('label', {title: 'Lets the windows of this mod load data, images and fonts from the internet (for example a web radio). Only for mods you trust.'},
                                       network, document.createTextNode(' Internet access'));
            network.addEventListener('change', async () => {
                try {
                    await rpc.setModNetwork(mod.id, network.checked);
                } catch(e) {
                    showError(`Could not change the internet access of the mod: ${e.message}`);
                    network.checked = mod.network === true;
                    return;
                }
                refresh();
            });
            actions.append(networkLabel);
        }
        const enable = async () => {
            try {
                // Approve exactly the content that was listed: the server refuses to enable a
                // mod whose files changed since the hash shown here was reviewed.
                await rpc.setModEnabled(mod.id, true, mod.hash);
            } catch(e) {
                window.alert(`Could not enable the mod: ${e.message}`);
            }
            refresh();
        };
        if (!mod.error) {
            if (mod.enabled) {
                actions.append(button('Disable', 'toggle_off', async () => {
                    await rpc.setModEnabled(mod.id, false);
                    refresh();
                }));
            } else {
                actions.append(button(mod.changed ? 'Approve again' : 'Enable', 'toggle_on', () => {
                    confirmBox.hidden = false;
                }, 'primary'));
                confirmBox.append(button('Enable anyway', 'check', enable, 'primary'),
                                  button('Cancel', 'close', () => (confirmBox.hidden = true)));
            }
        }
        const entry = storeEntryOf(manifest);
        if (entry && !mod.error) {
            const release = newestRelease(entry);
            if (release) {
                const newest = release.version || '';
                lines.push(el('div', {className: 'meta', text: `Store version: v${newest}`}));
                const isUpdate = compareVersions(newest, manifest.version) > 0;
                const updateConfirm = el('div', {className: 'confirm', attrs: {hidden: ''}},
                                         el('span', {text: 'Your settings are kept (they live in this app, per window). ' +
                                                           'The mod is switched off until you approve it again. '}));
                updateConfirm.append(
                    button('Install', 'download', async () => {
                        updateConfirm.hidden = true;
                        let done;
                        try {
                            done = await rpc.installMod(entry.id, release.version);
                        } catch(e) {
                            showError(`Not installed: ${e.message}`);
                            return;
                        }
                        const note = done.id === mod.id ?
                            `Replaced with the store version v${done.version}. Enable it again to approve the new files.` :
                            `The store package uses another mod id (${done.id}), so it was installed next to this one: ` +
                            `enable it, move your windows over and then remove the old copy (${mod.id}).`;
                        lastModNote = note;
                        refreshAfterModChange();
                    }, 'primary'),
                    button('Cancel', 'close', () => (updateConfirm.hidden = true)));
                actions.append(button(isUpdate ? `Update to v${newest}` : 'Switch to the store version',
                                      'download', () => (updateConfirm.hidden = false),
                                      isUpdate ? 'primary' : ''));
                lines.push(updateConfirm);
            }
        }
        const removeConfirm = el('div', {className: 'confirm', attrs: {hidden: ''}},
                                 el('span', {text: 'Delete the files of this mod? '}));
        removeConfirm.append(button('Delete', 'delete', async () => {
            try {
                await rpc.removeMod(mod.id);
            } catch(e) {
                window.alert(`Could not remove the mod: ${e.message}`);
            }
            refresh();
        }, 'danger'), button('Cancel', 'close', () => (removeConfirm.hidden = true)));
        actions.append(button('Remove', 'delete', () => (removeConfirm.hidden = false)));
        lines.push(actions, confirmBox, removeConfirm);
    }
    row.append(...lines);
    return row;
}


async function renderMods() {
    const root = document.querySelector('.mods');
    let mods;
    try {
        mods = await rpc.getAvailableMods();
    } catch(e) {
        root.replaceChildren(el('p', {className: 'error', text: `The mod list could not be loaded: ${e.message}`}));
        return;
    }
    if (!mods.length) {
        root.replaceChildren(el('p', {className: 'hint', text: 'No mods are installed.'}));
        return;
    }
    const rows = mods.map(modRow);
    root.replaceChildren(...(lastModNote ? [el('p', {className: 'hint note', text: lastModNote}), ...rows] : rows));
}


let storeMods = [];
function renderStoreList() {
    const root = document.querySelector('.store-list');
    const filter = document.querySelector('.store-filter').value.trim().toLowerCase();
    const shown = storeMods.filter(m => !filter ||
        `${m.name} ${m.description} ${(m.tags || []).join(' ')}`.toLowerCase().includes(filter));
    root.replaceChildren(...shown.map(storeRow));
}


function storeRow(mod) {
    const releases = mod.releases || [];
    const select = el('select', {attrs: {'aria-label': 'Version'}},
                      ...releases.map(r => el('option', {text: r.version, attrs: {value: r.version}})));
    const result = el('span', {className: 'result'});
    const install = button('Install', 'download', async ev => {
        const b = ev.currentTarget;
        b.disabled = true;
        result.textContent = 'Installing...';
        try {
            const done = await rpc.installMod(mod.id, select.value || undefined);
            result.textContent = (done.replaced ?
                `Updated to ${done.version}. Approve it again to switch it on.` :
                `Installed ${done.version} (disabled).`) +
                (done.source === 'github' ?
                    ' (installed from its GitHub repository: ' + done.repo +
                    '; the store file server is no longer online)' : '');
            refreshAfterModChange();
        } catch(e) {
            result.textContent = `Not installed: ${e.message}`;
        } finally {
            b.disabled = false;
        }
    }, 'primary');
    const lines = [
        el('div', {className: 'head'}, el('span', {className: 'name', text: mod.name}),
           ...(mod.tags || []).map(t => el('span', {className: 'tag', text: t}))),
        el('div', {className: 'desc', text: mod.description}),
    ];
    if (mod.homeURL) {
        lines.push(el('a', {className: 'meta', text: 'Home page',
                            attrs: {href: mod.homeURL, target: '_blank', rel: 'noopener noreferrer'}}));
    }
    lines.push(el('div', {className: 'actions'}, select, install, result));
    return el('div', {className: 'mod'}, ...lines);
}


async function loadStore(ev) {
    const b = ev.currentTarget;
    b.disabled = true;
    const root = document.querySelector('.store-list');
    root.replaceChildren(el('i', {text: 'Loading the store...'}));
    try {
        storeMods = await rpc.getModStore();
        document.querySelector('.store-filter').hidden = false;
        renderStoreList();
    } catch(e) {
        root.replaceChildren(el('p', {className: 'error', text: `The store could not be read: ${e.message}`}));
    } finally {
        b.disabled = false;
    }
}


// The store list is also needed to offer the store version of mods that were installed from GitHub,
// so an administrator gets it loaded in the background (once, never blocking the page).
async function ensureStoreLoaded() {
    if (!admin || storeMods.length) {
        return;
    }
    try {
        storeMods = await rpc.getModStore();
    } catch(e) {
        return;
    }
    const storePanel = document.querySelector('.store');
    if (storePanel && !storePanel.hidden) {
        document.querySelector('.store-filter').hidden = false;
        renderStoreList();
    }
    renderMods();
}


async function installFromGitHub(ev) {
    const b = ev.currentTarget;
    const repo = document.querySelector('.github-repo').value.trim();
    const ref = document.querySelector('.github-ref').value.trim();
    const result = document.querySelector('.github-result');
    if (!repo) {
        result.textContent = 'Paste a GitHub link first.';
        return;
    }
    b.disabled = true;
    result.textContent = 'Installing...';
    try {
        const done = await rpc.installModFromGitHub(repo, ref || undefined);
        result.textContent = done.replaced ?
            `Updated ${done.id}. Approve it again to switch it on.` :
            `Installed ${done.id} (disabled).`;
        refreshAfterModChange();
    } catch(e) {
        result.textContent = `Not installed: ${e.message}`;
    } finally {
        b.disabled = false;
    }
}


const ZIP_MAX_BYTES = 18 * 1024 * 1024;

function fileToBase64(file) {
    return file.arrayBuffer().then(buf => {
        const bytes = new Uint8Array(buf);
        const chunks = [];
        for (let i = 0; i < bytes.length; i += 0x8000) {
            chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
        }
        return btoa(chunks.join(''));
    });
}


function initZipInstall() {
    const actions = document.querySelector('.store');
    const picker = el('input', {className: 'zip-file', attrs: {type: 'file', accept: '.zip,application/zip'}});
    const result = el('span', {className: 'result'});
    const install = button('Install', 'download', async ev => {
        const b = ev.currentTarget;
        const chosen = picker.files && picker.files[0];
        if (!chosen) {
            result.textContent = 'Choose a .zip file first.';
            return;
        }
        if (chosen.size > ZIP_MAX_BYTES) {
            result.textContent = 'The file is larger than 18 MB';
            return;
        }
        b.disabled = true;
        result.textContent = 'Installing...';
        try {
            const done = await rpc.installModFromZip(await fileToBase64(chosen));
            result.textContent = done.replaced ?
                `Updated ${done.id}. Approve it again to switch it on.` :
                `Installed ${done.id} (disabled).`;
            refreshAfterModChange();
        } catch(e) {
            result.textContent = `Not installed: ${e.message}`;
        } finally {
            b.disabled = false;
        }
    }, 'primary');
    actions.append(el('div', {className: 'zip-install'},
                      el('h3', {text: 'Install from a ZIP file'}),
                      el('div', {className: 'store-controls zip'}, picker, install, result)));
}


export async function main() {
    Common.initInteractionListeners();
    try {
        const me = await (await fetch('/api/me')).json();
        admin = me?.user?.role === 'administrator';
    } catch(e) {
        admin = false;
    }
    document.querySelector('.admin-note').hidden = admin;
    document.querySelector('.store').hidden = !admin;
    document.querySelector('.load-store').addEventListener('click', loadStore);
    document.querySelector('.store-filter').addEventListener('input', renderStoreList);
    document.querySelector('.install-github').addEventListener('click', installFromGitHub);
    initZipInstall();
    await renderMods();
    ensureStoreLoaded();
}
