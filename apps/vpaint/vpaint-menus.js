// ============================================================
// apps/vpaint/vpaint-menus.js
// VLC-style dropdown menu bar for vPaint.
// Mirrors the pattern in vmedia-menus.js exactly.
//
// initVPaintMenus(windowEl, actions)
//   actions: {
//     savePNG, clear, close,
//     undo, copy, cut, paste, selectAll,
//     rotate90, flipH, flipV, resize,
//     postToGallery,                  ← moved from ribbon
//   }
// ============================================================

const VP_MENUS = {
    file: [
        { label: 'Save PNG',        action: 'save-png'   },
        { label: 'Clear Canvas…',   action: 'clear'      },
        { sep: true },
        { label: 'Close',           action: 'close'      },
    ],
    edit: [
        { label: 'Undo',            action: 'undo',       hint: 'Ctrl+Z' },
        { sep: true },
        { label: 'Copy',            action: 'copy',       hint: 'Ctrl+C' },
        { label: 'Cut',             action: 'cut',        hint: 'Ctrl+X' },
        { label: 'Paste',           action: 'paste',      hint: 'Ctrl+V' },
        { label: 'Select All',      action: 'select-all', hint: 'Ctrl+A' },
    ],
    image: [
        { label: 'Rotate 90°',      action: 'rotate90'   },
        { label: 'Flip Horizontal', action: 'flip-h'     },
        { label: 'Flip Vertical',   action: 'flip-v'     },
        { sep: true },
        { label: 'Resize / Skew…',  action: 'resize'     },
    ],
    gallery: [
        { label: 'Post to Gallery…',action: 'post',       id: 'vpm-item-post' },
        { sep: true },
        { label: 'View Gallery',    action: 'tab-gallery' },
    ],
};

export function initVPaintMenus(windowEl, actions) {
    let openMenuKey = null;
    let openDropEl  = null;

    function buildDropdown(key) {
        const items = VP_MENUS[key];
        if (!items) return null;

        const drop = document.createElement('div');
        drop.className    = 'wmp-dropdown vp-dropdown';
        drop.dataset.menu = key;

        items.forEach(item => {
            if (item.sep) {
                const sep = document.createElement('div');
                sep.className = 'wmp-dropdown-sep';
                drop.appendChild(sep);
                return;
            }
            const el = document.createElement('div');
            el.className = 'wmp-dropdown-item' + (item.disabled ? ' disabled' : '');
            if (item.id) el.id = item.id;

            const labelSpan = document.createElement('span');
            labelSpan.textContent = item.label;
            el.appendChild(labelSpan);

            if (item.hint) {
                const hint = document.createElement('span');
                hint.className   = 'vp-menu-hint';
                hint.textContent = item.hint;
                el.appendChild(hint);
            }

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
            case 'save-png':    actions.savePNG (); break;
            case 'clear':       actions.clear   (); break;
            case 'close':       actions.close   (); break;
            case 'undo':        actions.undo    (); break;
            case 'copy':        actions.copy    (); break;
            case 'cut':         actions.cut     (); break;
            case 'paste':       actions.paste   (); break;
            case 'select-all':  actions.selectAll(); break;
            case 'rotate90':    actions.rotate90(); break;
            case 'flip-h':      actions.flipH   (); break;
            case 'flip-v':      actions.flipV   (); break;
            case 'resize':      actions.resize  (); break;
            case 'post':        actions.postToGallery(); break;
            case 'tab-gallery': actions.tabGallery();   break;
        }
    }

    windowEl.querySelectorAll('.vp-menu-item[data-menu]').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const key = btn.dataset.menu;
            if (openMenuKey === key) { closeDropdown(); return; }
            openDropdown(key, btn);
        });
    });

    document.addEventListener('click', () => closeDropdown());
}
