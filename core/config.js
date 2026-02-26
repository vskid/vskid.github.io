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
                date:  '21 - 02 - 2026',
                href:  'https://github.com/notifications-star/lifeos',
            },
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
                date:  '25 - 10 - 1987',
                id:    'dQw4w9WgXcQ',
                title: 'Important Message!',
            },
            {
                type:  'video',
                icon:  '🎬',
                name:  'Man Plays Saxophone',
                date:  '25 - 10 - 1987',
                id:    '/videos/Video-by-perrellcpt-_IG_p_Cw4C7cMsL76_-copy.webm',
                title: 'Man Plays Saxophone',
            },
            {
                type:  'video',
                icon:  '🎬',
                name:  'National Anthem',
                date:  '27 - 02 - 2020',
                id:    'WyKAZt27A9w',
                title: 'National Anthem',
            },
            {
                type:  'video',
                icon:  '🎬',
                name:  'Video Taken 2001',
                date:  '11 - 09 - 2001',
                id:    '/videos/nokiavideotest.webm',
                title: 'Video Taken 2001',
            },
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
                date:  '25 - 02 - 2026',
                src:   '/music/Darude - Sandstorm.mp3',
                title: 'Darude - Sandstorm',
            },
            {
                type:  'audio',
                icon:  '🎧',
                name:  'Kalimba (Ninja Tuna)',
                date:  '25 - 02 - 2026',
                src:   '/music/Mr Scruff - Kalimba (Ninja Tuna).mp3',
                title: 'Mr Scruff - Kalimba (Ninja Tuna)',
            },
            {
                type:  'audio',
                icon:  '🎧',
                name:  'Joan Progression',
                date:  '25 - 02 - 2026',
                src:   '/music/chordtest joanprog.mp3',
                title: 'Joan Progression',
            },
            {
                type:  'audio',
                icon:  '🎧',
                name:  'McDonalds beat',
                date:  '17 - 11 - 2024',
                src:   '/music/mcd cook 17 11 2024.mp3',
                title: 'McDonalds beat 17 - 11 - 2024',
            },
            {
                type:  'audio',
                icon:  '🎧',
                name:  'TB-303 test',
                date:  '25 - 02 - 2026',
                src:   '/music/tb303 test.mp3',
                title: 'TB-303 test',
            },
            {
                type:  'audio',
                icon:  '🎧',
                name:  'Test Project #1',
                date:  '25 - 02 - 2026',
                src:   '/music/Testproj1.mp3',
                title: 'Test Project #1',
            },
            {
                type:  'audio',
                icon:  '🎧',
                name:  'Test Project #2',
                date:  '25 - 02 - 2026',
                src:   '/music/testproj2.mp3',
                title: 'Test Project #2',
            },
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
                date:  '01 - 01 - 2025',
                src:   'https://upload.wikimedia.org/wikipedia/commons/b/b8/Loss.svg',
                title: 'Example Image',
            },
            {
                type:  'image',
                icon:  '🖼️',
                name:  'Test Image',
                date:  '01 - 01 - 2025',
                src:   'https://upload.wikimedia.org/wikipedia/en/7/73/Trollface.png',
                title: 'Test Image',
            },
        ],
    },
    {
        iconId:   'open-docs',
        windowId: 'docs-window',
        title:    'Documents',
        icon:     '📄',
        path:     'vskid/Documents',
        items: [
            { 
                type:'doc', 
                icon:'📄', 
                name:'Hello World', 
                date:'25 - 02 - 2025',
                id:'hello-world', 
                title:'Hello World' 
            },
        ],
    },
];

export const BLOG_POSTS = [
     {
         id:      'hello-world',
         title:   'Hello World',
         date:    '01 - 01 - 2025',
         summary: 'My first post.',
         file:    'posts/hello-world.md',
     },
];

export const WALL_PASSWORD = 'John 3:16';

// ── World Clock cities ────────────────────────────────────────
// Each entry: { id, label, tz, vdocId? }
// tz = IANA timezone name: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
// vdocId = optional blog post id from BLOG_POSTS above; shows a link icon on the card.
export const CITIES = [
    // ── Southeast Asia ──────────────────────────────────────
    { id: 'WIII', label: 'Jakarta',     tz: 'Asia/Jakarta',        vdocId: null, lat: -6.2088, lng: 106.8456  },
    { id: 'WAHQ', label: 'Solo',        tz: 'Asia/Jakarta',        vdocId: null, lat: -7.5755, lng: 110.8243  },
    { id: 'WAHS', label: 'Semarang',    tz: 'Asia/Jakarta',        vdocId: null, lat: -6.9666, lng: 110.4201  },
    { id: 'WADL', label: 'Lombok',      tz: 'Asia/Makassar',       vdocId: null, lat: -8.6500, lng: 116.3242  },
    { id: 'WADD', label: 'Bali',        tz: 'Asia/Makassar',       vdocId: null, lat: -8.3405, lng: 115.0920  },
    { id: 'WMKK', label: 'Kuala Lumpur',tz: 'Asia/Kuala_Lumpur',   vdocId: null, lat:  3.1390, lng: 101.6869  },
    { id: 'WSSS', label: 'Singapore',   tz: 'Asia/Singapore',      vdocId: null, lat:  1.3521, lng: 103.8198  },
    { id: 'VTBS', label: 'Bangkok',     tz: 'Asia/Bangkok',        vdocId: null, lat: 13.7563, lng: 100.5018  },
    // ── East Asia ───────────────────────────────────────────
    { id: 'ZSHC', label: 'Hangzhou',   tz: 'Asia/Shanghai',       vdocId: null, lat: 30.2741,  lng: 120.1551  },
    { id: 'VHHH', label: 'Hong Kong',  tz: 'Asia/Hong_Kong',      vdocId: null, lat: 22.3193,  lng: 114.1694 },
    { id: 'RJTT', label: 'Tokyo',      tz: 'Asia/Tokyo',          vdocId: null, lat: 35.6762,  lng: 139.6503 },
    { id: 'YSSY', label: 'Sydney',     tz: 'Australia/Sydney',    vdocId: null, lat: -33.8688, lng: 151.2093 },
    { id: 'KDEN', label: 'Denver',     tz: 'America/Denver',      vdocId: null, lat: 39.7392,  lng: -104.9903 },
    { id: 'KLAX', label: 'Los Angeles',tz: 'America/Los_Angeles', vdocId: null, lat: 34.0522,  lng: -118.2437 },
    { id: 'KSAN', label: 'San Diego',  tz: 'America/Los_Angeles', vdocId: null, lat: 32.7157,  lng: -117.1611 }
    // ── Add more cities here ─────────────────────────────────
    // { id: 'tokyo',  label: 'Tokyo',       tz: 'Asia/Tokyo',          vdocId: 'japan-trip', lat: 35.6762, lng: 139.6503 },
    // { id: 'london', label: 'London',      tz: 'Europe/London',       vdocId: null,         lat: 51.5074, lng: -0.1278  },
];