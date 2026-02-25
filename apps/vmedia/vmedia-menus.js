// ============================================================
// vmedia-menus.js — VLC-style dropdown menu bar
// ============================================================
// initMenus(windowEl, actions)
//   actions: { toggleEQ, playPause, restart, speed, close, about }
// ============================================================

const MENUS = {
    file: [
        { label: 'Open File…',    action: 'file-open-dialog' },
        { label: 'Open URL…',     action: 'url-open-dialog'  },
        { sep: true },
        { label: 'Close',         action: 'close-player'     },
    ],
    view: [
        { label: 'Always on Top', action: 'noop', disabled: true },
    ],
    playback: [
        { label: 'Play / Pause',  action: 'playpause' },
        { label: 'Restart',       action: 'restart'   },
        { sep: true },
        { label: 'Speed: 1×',     action: 'speed', id: 'menu-item-speed' },
    ],
    tools: [
        { label: 'Equalizer',     action: 'toggle-eq', id: 'menu-item-eq' },
        { sep: true },
        { label: 'Preferences',   action: 'noop', disabled: true },
    ],
    help: [
        { label: 'About vMedia',  action: 'about' },
    ],
};

export function initMenus(windowEl, actions) {
    let openMenuKey = null;
    let openDropEl  = null;

    function buildDropdown(key) {
        const items = MENUS[key];
        if (!items) return null;

        const drop = document.createElement('div');
        drop.className    = 'wmp-dropdown';
        drop.dataset.menu = key;

        items.forEach(item => {
            if (item.sep) {
                const sep = document.createElement('div');
                sep.className = 'wmp-dropdown-sep';
                drop.appendChild(sep);
                return;
            }
            const el = document.createElement('div');
            el.className  = 'wmp-dropdown-item' + (item.disabled ? ' disabled' : '');
            el.textContent = item.label;
            if (item.id) el.id = item.id;
            if (!item.disabled) {
                el.addEventListener('click', e => {
                    e.stopPropagation();
                    dispatch(item.action);
                    closeDropdown();
                });
            }
            drop.appendChild(el);
        });
        return drop;
    }

    function openDropdown(key, anchorEl) {
        closeDropdown();
        const drop = buildDropdown(key);
        if (!drop) return;
        const rect = anchorEl.getBoundingClientRect();
        drop.style.left = rect.left + 'px';
        drop.style.top  = (rect.bottom + 2) + 'px';
        document.body.appendChild(drop);
        openMenuKey = key;
        openDropEl  = drop;
        anchorEl.classList.add('active');
    }

    function closeDropdown() {
        openDropEl?.remove();
        openDropEl = null;
        if (openMenuKey) {
            windowEl.querySelector(`[data-menu="${openMenuKey}"]`)
                ?.classList.remove('active');
            openMenuKey = null;
        }
    }

    function dispatch(action) {
        switch (action) {
            case 'toggle-eq':      actions.toggleEQ();    break;
            case 'playpause':      actions.playPause();   break;
            case 'restart':        actions.restart();     break;
            case 'speed':          actions.speed();       break;
            case 'close-player':   actions.close();       break;
            case 'about':
                alert('vMedia — modular web media player\nPart of vskid.github.io desktop');
                break;
            default: break;
        }
    }

    windowEl.querySelectorAll('.wmp-menu-item[data-menu]').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const key = btn.dataset.menu;
            if (openMenuKey === key) { closeDropdown(); return; }
            openDropdown(key, btn);
        });
    });

    document.addEventListener('click', () => closeDropdown());
}