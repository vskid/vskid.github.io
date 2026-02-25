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
            {
                type:  'video',
                icon:  '🎬',
                name:  'Man Plays Saxophone',
                date:  '25-10-87',
                id:    '/videos/Video-by-perrellcpt-_IG_p_Cw4C7cMsL76_-copy.webm',
                title: 'Man Plays Saxophone',
            },
            {
                type:  'video',
                icon:  '🎬',
                name:  'National Anthem',
                date:  '27-02-2020',
                id:    'WyKAZt27A9w',
                title: 'National Anthem',
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
                src:   '/music/Darude - Sandstorm.mp3',
                title: 'Darude - Sandstorm',
            },
            {
                type:  'audio',
                icon:  '🎧',
                name:  'Kalimba (Ninja Tuna)',
                date:  '25-02-26',
                src:   '/music/Mr Scruff - Kalimba (Ninja Tuna).mp3',
                title: 'Mr Scruff - Kalimba (Ninja Tuna)',
            },
            {
                type:  'audio',
                icon:  '🎧',
                name:  'Joan Progression',
                date:  '25-02-26',
                src:   '/music/chordtest joanprog.mp3',
                title: 'Joan Progression',
            },
            {
                type:  'audio',
                icon:  '🎧',
                name:  'McDonalds beat 17-11-24',
                date:  '17-11-24',
                src:   '/music/mcd cook 17 11 2024.mp3',
                title: 'McDonalds beat 17-11-24',
            },
            {
                type:  'audio',
                icon:  '🎧',
                name:  'TB-303 test',
                date:  '25-02-26',
                src:   '/music/tb303 test.mp3',
                title: 'TB-303 test',
            },
            {
                type:  'audio',
                icon:  '🎧',
                name:  'Test Project #1',
                date:  '25-02-26',
                src:   '/music/Testproj1.mp3',
                title: 'Test Project #1',
            },
            {
                type:  'audio',
                icon:  '🎧',
                name:  'Test Project #2',
                date:  '25-02-26',
                src:   '/music/testproj2.mp3',
                title: 'Test Project #2',
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
                src:   'https://upload.wikimedia.org/wikipedia/commons/b/b8/Loss.svg',
                title: 'Example Image',
            },
            {
                type:  'image',
                icon:  '🖼️',
                name:  'Test Image',
                date:  '01-01-25',
                src:   'https://upload.wikimedia.org/wikipedia/en/7/73/Trollface.png',
                title: 'Test Image',
            },
            // Add images here
        ],
    },
];
