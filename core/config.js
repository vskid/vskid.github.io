// ============================================================
// core/config.js
// ============================================================
// All content data for the desktop.
//
// FOLDERS defines the explorer windows. Each folder has:
//   iconId    ; desktop icon element ID
//   windowId  ; ID to give the injected window element
//   title     ; display name in the title bar
//   icon      ; emoji for the title bar
//   path      ; fake address bar path
//   items     ; array of file items (see types below)
//
// Item types:
//   project : { type:'project', icon, name, date, href }
//   video   : { type:'video',   icon, name, date, id, title }
//   audio   : { type:'audio',   icon, name, date, src, title }
//   image   : { type:'image',   icon, name, date, src, title }
// ============================================================

export const FOLDERS = [
    {
        iconId:   'open-projects',
        windowId: 'projects-window',
        title:    'Projects',
        icon:     '📁',
        path:     'vskid/Projects',
        items: [
            {
                type:  'project',
                icon:  '🔗',
                name:  'Momentum',
                date:  '21-02-26',
                href:  'https://github.com/notifications-star/lifeos',
            },
            // Add projects here
        ],
    },
    {
        iconId:   'open-videos',
        windowId: 'videos-window',
        title:    'Videos',
        icon:     '🎬',
        path:     'vskid/Videos',
        items: [
            {
                type:  'video',
                icon:  '🎬',
                name:  'Important Message!',
                date:  '25-10-87',
                id:    'dQw4w9WgXcQ',
                title: 'Important Message!',
            },
            // Add videos here
        ],
    },
    {
        iconId:   'open-music',
        windowId: 'music-window',
        title:    'Music',
        icon:     '🎵',
        path:     'vskid/Music',
        items: [
            {
                type:  'audio',
                icon:  '🎧',
                name:  'Sandstorm',
                date:  '25-02-26',
                src:   'https://open.spotify.com/embed/track/4PTG3Z6ehGkBFwjybzWkR8?utm_source=generator',
                title: 'Darude - Sandstorm',
            },
            // Add audio here
            // Self-hosted mp3 example:
            // { type:'audio', icon:'🎵', name:'Track Name', date:'DD-MM-YY',
            //   src:'/music/your-track.mp3', title:'Artist - Track Name' },
        ],
    },
    {
        iconId:   'open-pictures',
        windowId: 'pictures-window',
        title:    'Pictures',
        icon:     '🖼️',
        path:     'vskid/Pictures',
        items: [
            {
                type:  'image',
                icon:  '🖼️',
                name:  'Example',
                date:  '01-01-25',
                src:   'https://upload.wikimedia.org/wikipedia/commons/8/8b/Minimalist_loss.svg',
                title: 'Example Image',
            },
            // Add images here
        ],
    },
];
