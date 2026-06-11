/**
 * Wallpapers - CSS pattern definitions and image wallpaper discovery.
 *
 * Each pattern has: name, backgroundColor, backgroundImage, backgroundSize,
 * and optionally backgroundPosition.
 */

export const cssPatterns = [
    {
        name: 'Grid',
        backgroundColor: '#d3d3d32e',
        backgroundImage: 'linear-gradient(rgb(107 107 107 / 14%) 1px, transparent 1px), linear-gradient(90deg, rgba(140, 160, 180, 0.35) 1px, transparent 1px)',
        backgroundSize: '10px 10px',
    },
    {
        name: 'Dots',
        backgroundColor: '#f0f0f0',
        backgroundImage: 'radial-gradient(circle, #b0b0b0 1px, transparent 1px)',
        backgroundSize: '20px 20px',
    },
    {
        name: 'Diagonal Lines',
        backgroundColor: '#f5f5f5',
        backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(0,0,0,0.03) 10px, rgba(0,0,0,0.03) 11px)',
        backgroundSize: 'auto',
    },
    {
        name: 'Blueprint',
        backgroundColor: '#1a2a3a',
        backgroundImage: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)',
        backgroundSize: '100px 100px, 100px 100px, 20px 20px, 20px 20px',
    },
    {
        name: 'Carbon',
        backgroundColor: '#2c2c2c',
        backgroundImage: 'linear-gradient(27deg, #1a1a1a 5px, transparent 5px), linear-gradient(207deg, #1a1a1a 5px, transparent 5px), linear-gradient(27deg, #222 5px, transparent 5px), linear-gradient(207deg, #222 5px, transparent 5px), linear-gradient(90deg, #1b1b1b 10px, transparent 10px), linear-gradient(#222 25%, #1b1b1b 25%, #1b1b1b 50%, transparent 50%, transparent 75%, #242424 75%, #242424)',
        backgroundSize: '30px 30px',
    },
    {
        name: 'Isometric',
        backgroundColor: '#e8e8e8',
        backgroundImage: 'linear-gradient(30deg, #d0d0d0 12%, transparent 12.5%, transparent 87%, #d0d0d0 87.5%, #d0d0d0), linear-gradient(150deg, #d0d0d0 12%, transparent 12.5%, transparent 87%, #d0d0d0 87.5%, #d0d0d0), linear-gradient(30deg, #d0d0d0 12%, transparent 12.5%, transparent 87%, #d0d0d0 87.5%, #d0d0d0), linear-gradient(150deg, #d0d0d0 12%, transparent 12.5%, transparent 87%, #d0d0d0 87.5%, #d0d0d0), linear-gradient(60deg, #d8d8d8 25%, transparent 25.5%, transparent 75%, #d8d8d8 75%, #d8d8d8), linear-gradient(60deg, #d8d8d8 25%, transparent 25.5%, transparent 75%, #d8d8d8 75%, #d8d8d8)',
        backgroundSize: '40px 70px',
        backgroundPosition: '0 0, 0 0, 20px 35px, 20px 35px, 0 0, 20px 35px',
    },
    {
        name: 'Honeycomb',
        backgroundColor: '#f0ead6',
        backgroundImage: 'radial-gradient(circle farthest-side at 0% 50%, transparent 23.5%, rgba(170,160,130,0.15) 24%, rgba(170,160,130,0.15) 27.8%, transparent 28.5%), radial-gradient(circle farthest-side at 0% 50%, transparent 23.5%, rgba(170,160,130,0.15) 24%, rgba(170,160,130,0.15) 27.8%, transparent 28.5%)',
        backgroundSize: '40px 56px',
        backgroundPosition: '20px 28px, 0 0',
    },
    {
        name: 'None',
        backgroundColor: 'transparent',
        backgroundImage: 'none',
        backgroundSize: 'auto',
    },
];

/**
 * Fetch available image wallpapers from the server.
 * Returns [{name, url}]
 */
export async function fetchImageWallpapers() {
    try {
        const resp = await fetch('api/wallpapers');
        if (!resp.ok) return [];
        return await resp.json();
    } catch {
        return [];
    }
}

/**
 * Apply a CSS pattern wallpaper.
 */
export function applyCssPattern(pattern) {
    const html = document.documentElement;
    const body = document.body;
    // Clear image wallpaper
    html.style.backgroundImage = pattern.backgroundImage;
    html.style.backgroundColor = pattern.backgroundColor;
    html.style.backgroundSize = pattern.backgroundSize;
    html.style.backgroundPosition = pattern.backgroundPosition || '';
    body.style.backgroundImage = pattern.backgroundImage;
    body.style.backgroundColor = pattern.backgroundColor;
    body.style.backgroundSize = pattern.backgroundSize;
    body.style.backgroundPosition = pattern.backgroundPosition || '';
}

/**
 * Apply an image wallpaper.
 */
export function applyImageWallpaper(url) {
    const html = document.documentElement;
    const body = document.body;
    html.style.backgroundImage = `url('${url}')`;
    html.style.backgroundColor = '#1a1a1a';
    html.style.backgroundSize = 'cover';
    html.style.backgroundPosition = 'center';
    body.style.backgroundImage = `url('${url}')`;
    body.style.backgroundColor = '#1a1a1a';
    body.style.backgroundSize = 'cover';
    body.style.backgroundPosition = 'center';
}

/**
 * Restore wallpaper from localStorage.
 */
export function restoreWallpaper() {
    const saved = localStorage.getItem('wallpaper');
    const data = saved ? JSON.parse(saved) : { type: 'image', name: 'natural park', url: 'wallpapers/natural_park.jpg' };
    try {
        if (data.type === 'pattern') {
            const pattern = cssPatterns.find(p => p.name === data.name);
            if (pattern) applyCssPattern(pattern);
        } else if (data.type === 'image') {
            applyImageWallpaper(data.url);
        }
    } catch { /* keep default */ }
}
