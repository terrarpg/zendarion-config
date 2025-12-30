const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const app = express();
const port = process.env.PORT || 3000;

// ================= CONFIGURATION =================
const CONFIG = {
    // URL de base des serveurs officiels
    MOJANG_ASSETS: 'https://resources.download.minecraft.net',
    MOJANG_LIBRARIES: 'https://libraries.minecraft.net',
    FORGE_MAVEN: 'https://maven.minecraftforge.net',
    FORGE_MAVEN_FALLBACK: 'https://files.minecraftforge.net/maven',
    
    // Mappings des fichiers Forge
    FORGE_MAPPINGS: {
        'net/minecraftforge/forge': 'https://maven.minecraftforge.net/net/minecraftforge/forge',
        'net/minecraftforge/fancymodloader': 'https://maven.minecraftforge.net/net/minecraftforge/fancymodloader',
        'net/minecraftforge/eventbus': 'https://maven.minecraftforge.net/net/minecraftforge/eventbus',
        'net/minecraftforge/common': 'https://maven.minecraftforge.net/net/minecraftforge/common',
        'cpw/mods': 'https://maven.minecraftforge.net/cpw/mods',
        'org/ow2/asm': 'https://repo1.maven.org/maven2/org/ow2/asm'
    },
    
    // Cache des fichiers téléchargés
    CACHE_DIR: path.join(__dirname, 'cache'),
    CACHE_TTL: 24 * 60 * 60 * 1000, // 24 heures
};

// ================= MIDDLEWARE =================
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    next();
});

app.use(express.json());

// Créer le dossier cache
if (!fs.existsSync(CONFIG.CACHE_DIR)) {
    fs.mkdirSync(CONFIG.CACHE_DIR, { recursive: true });
}

// ================= FONCTIONS UTILITAIRES =================

/**
 * Télécharge un fichier depuis une URL et le sauvegarde
 */
async function downloadAndCache(url, destination) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const tempFile = destination + '.tmp';
        
        // Vérifier si déjà en cache et valide
        if (fs.existsSync(destination)) {
            const stats = fs.statSync(destination);
            const age = Date.now() - stats.mtimeMs;
            
            if (age < CONFIG.CACHE_TTL && stats.size > 0) {
                console.log(`✅ Utilisation du cache: ${path.basename(destination)}`);
                return resolve(true);
            }
        }
        
        console.log(`🌐 Téléchargement depuis: ${url}`);
        
        const fileStream = fs.createWriteStream(tempFile);
        const request = protocol.get(url, (response) => {
            if (response.statusCode === 200) {
                response.pipe(fileStream);
                
                fileStream.on('finish', () => {
                    fileStream.close();
                    
                    // Renommer le fichier temporaire
                    fs.renameSync(tempFile, destination);
                    
                    console.log(`✅ Téléchargé et caché: ${path.basename(destination)} (${response.headers['content-length']} bytes)`);
                    resolve(true);
                });
            } else {
                fileStream.close();
                fs.unlinkSync(tempFile);
                console.log(`❌ Échec téléchargement (${response.statusCode}): ${url}`);
                resolve(false);
            }
        });
        
        request.on('error', (error) => {
            fileStream.close();
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
            console.log(`❌ Erreur connexion: ${error.message}`);
            resolve(false);
        });
        
        request.setTimeout(30000, () => {
            request.destroy();
            fileStream.close();
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
            console.log(`⏱️ Timeout: ${url}`);
            resolve(false);
        });
    });
}

/**
 * Trouve l'URL correcte pour un fichier
 */
function resolveFileUrl(filePath, fileName) {
    // 1. Assets Minecraft (hash SHA1)
    if (fileName.length === 40 && /^[0-9a-f]{40}$/.test(fileName) && 
        filePath.includes('assets/objects/')) {
        const prefix = fileName.substring(0, 2);
        return `${CONFIG.MOJANG_ASSETS}/${prefix}/${fileName}`;
    }
    
    // 2. Libraries Minecraft
    if (filePath.includes('libraries/')) {
        // Libraries standard Minecraft
        if (filePath.includes('com/mojang') || 
            filePath.includes('net/minecraft') ||
            filePath.includes('it/unimi/dsi')) {
            return `${CONFIG.MOJANG_LIBRARIES}/${filePath}`;
        }
        
        // Libraries Forge
        for (const [prefix, baseUrl] of Object.entries(CONFIG.FORGE_MAPPINGS)) {
            if (filePath.includes(prefix)) {
                const relativePath = filePath.split(prefix)[1];
                return `${baseUrl}${relativePath}`;
            }
        }
        
        // Fallback général pour les libraries
        return `${CONFIG.MOJANG_LIBRARIES}/${filePath}`;
    }
    
    // 3. Fichiers Forge spécifiques
    if (fileName.includes('forge') || fileName.includes('minecraftforge')) {
        if (filePath.includes('versions/') && fileName.endsWith('.jar')) {
            const versionMatch = filePath.match(/versions\/([^\/]+)\//);
            if (versionMatch) {
                const version = versionMatch[1];
                return `${CONFIG.FORGE_MAVEN}/net/minecraftforge/forge/${version}/${fileName}`;
            }
        }
    }
    
    // 4. Fichier client Minecraft
    if (fileName === `${path.basename(path.dirname(filePath))}.jar` && 
        filePath.includes('versions/')) {
        const version = path.basename(path.dirname(filePath));
        return `https://launcher.mojang.com/v1/objects/client/${version}.jar`;
    }
    
    // 5. Par défaut, retourner null (fichier local uniquement)
    return null;
}

/**
 * Vérifie si un fichier existe sur un serveur distant
 */
async function checkRemoteFile(url) {
    return new Promise((resolve) => {
        const protocol = url.startsWith('https') ? https : http;
        const request = protocol.request(url, { method: 'HEAD' }, (response) => {
            resolve(response.statusCode === 200 || response.statusCode === 206);
        });
        
        request.on('error', () => resolve(false));
        request.setTimeout(5000, () => {
            request.destroy();
            resolve(false);
        });
        
        request.end();
    });
}

// ================= ROUTES PRINCIPALES =================

// 1. Configuration des instances
app.get('/files/instances.json', (req, res) => {
    console.log('📋 Configuration instances demandée');
    
    const config = {
        "zendariom": {
            "name": "zendariom",
            "url": `https://${req.get('host')}/files?instance=zendariom`,
            "loadder": {
                "minecraft_version": "1.20.1",
                "loadder_type": "Forge", // IMPORTANT: Forge
                "loadder_version": "latest"
            },
            "verify": true,
            "ignored": [
                "config",
                "logs", 
                "resourcepacks",
                "options.txt",
                "optionsof.txt",
                "**/*.x", // Ignorer fichiers temporaires
                "**/natives/**/*.tmp"
            ],
            "whitelist": ["Luuxis"],
            "whitelistActive": false,
            "status": {
                "nameServer": "ZENDARIOM",
                "ip": "91.197.6.16",
                "port": 26710
            },
            "features": {
                "auto_download": true,
                "forge_fallback": true,
                "cache_enabled": true
            }
        }
    };
    
    res.json(config);
});

// 2. Liste des fichiers avec URLs intelligentes
app.get('/files/', (req, res) => {
    const instanceName = req.query.instance;
    if (!instanceName) return res.json([]);
    
    const instancePath = path.join(__dirname, 'files', 'instances', instanceName);
    console.log(`🔍 Scan instance: ${instanceName}`);
    
    if (!fs.existsSync(instancePath)) {
        return res.json([]);
    }

    function scanDirectory(dir, basePath = '') {
        const results = [];
        
        try {
            const items = fs.readdirSync(dir);
            
            for (const item of items) {
                const fullPath = path.join(dir, item);
                const relativePath = basePath ? `${basePath}/${item}` : item;
                
                try {
                    const stats = fs.statSync(fullPath);
                    
                    if (stats.isDirectory()) {
                        // Ignorer les dossiers natives vides
                        if (relativePath.includes('/natives') && 
                            fs.readdirSync(fullPath).length === 0) {
                            continue;
                        }
                        results.push(...scanDirectory(fullPath, relativePath));
                    } else {
                        // Ignorer fichiers temporaires
                        if (item.endsWith('.x') || item.includes('.tmp')) {
                            continue;
                        }
                        
                        const fileUrl = resolveFileUrl(relativePath, item);
                        
                        results.push({
                            name: item,
                            path: relativePath.replace(/\\/g, '/'),
                            size: stats.size,
                            url: fileUrl || `https://${req.get('host')}/files/instances/${instanceName}/${relativePath.replace(/\\/g, '/')}`,
                            type: 'file',
                            modified: stats.mtime.toISOString(),
                            source: fileUrl ? 'remote' : 'local',
                            hash: item.length === 40 && /^[0-9a-f]{40}$/.test(item) ? item : null
                        });
                    }
                } catch (error) {
                    // Ignorer les erreurs
                }
            }
        } catch (error) {
            console.log(`⚠️ Erreur scan: ${error.message}`);
        }
        
        return results;
    }

    try {
        const files = scanDirectory(instancePath);
        console.log(`✅ ${files.length} fichiers listés (${files.filter(f => f.source === 'remote').length} depuis serveurs distants)`);
        res.json(files);
    } catch (error) {
        console.error('❌ Erreur:', error);
        res.json([]);
    }
});

// 3. Téléchargement intelligent avec fallback Forge
app.get('/files/instances/:instance/*', async (req, res) => {
    const instanceName = req.params.instance;
    const filePath = req.params[0];
    const fullLocalPath = path.join(__dirname, 'files', 'instances', instanceName, filePath);
    const fileName = path.basename(filePath);
    
    console.log(`📥 Demande: ${filePath}`);
    
    // Gestion fichiers temporaires
    if (fileName.endsWith('.x') || fileName.includes('.tmp')) {
        res.writeHead(200, { 
            'Content-Type': 'application/octet-stream', 
            'Content-Length': '0' 
        });
        return res.end();
    }
    
    // Étape 1: Vérifier localement
    if (fs.existsSync(fullLocalPath)) {
        const stats = fs.statSync(fullLocalPath);
        if (stats.size > 0) {
            console.log(`✅ Servi localement: ${stats.size} bytes`);
            return res.sendFile(fullLocalPath);
        }
    }
    
    // Étape 2: Chercher sur les serveurs distants
    const remoteUrl = resolveFileUrl(filePath, fileName);
    
    if (remoteUrl) {
        console.log(`🌐 Tentative de téléchargement depuis: ${remoteUrl}`);
        
        try {
            // Vérifier si le fichier existe à distance
            const exists = await checkRemoteFile(remoteUrl);
            
            if (exists) {
                // Télécharger et servir
                const cachePath = path.join(CONFIG.CACHE_DIR, 
                    Buffer.from(remoteUrl).toString('base64').replace(/[^a-zA-Z0-9]/g, ''));
                
                const success = await downloadAndCache(remoteUrl, cachePath);
                
                if (success) {
                    // Copier dans l'instance locale pour usage futur
                    const localDir = path.dirname(fullLocalPath);
                    if (!fs.existsSync(localDir)) {
                        fs.mkdirSync(localDir, { recursive: true });
                    }
                    fs.copyFileSync(cachePath, fullLocalPath);
                    
                    // Servir le fichier
                    return res.sendFile(cachePath);
                }
            } else {
                console.log(`❌ Fichier non trouvé sur les serveurs distants: ${fileName}`);
            }
        } catch (error) {
            console.log(`⚠️ Erreur téléchargement: ${error.message}`);
        }
    }
    
    // Étape 3: Pour les natives, créer un placeholder
    if (filePath.includes('/natives/') && 
        (fileName.endsWith('.dll') || fileName.endsWith('.so') || fileName.endsWith('.dylib'))) {
        console.log(`🛠️ Création placeholder pour native: ${fileName}`);
        const dir = path.dirname(fullLocalPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullLocalPath, Buffer.from([0x4D, 0x5A])); // Header minimal PE
        res.writeHead(200, { 
            'Content-Type': 'application/octet-stream', 
            'Content-Length': '2' 
        });
        return res.end(Buffer.from([0x4D, 0x5A]));
    }
    
    // Étape 4: Fichier introuvable
    console.log(`❌ Fichier introuvable: ${filePath}`);
    res.status(404).json({
        error: 'Fichier non trouvé',
        file: fileName,
        path: filePath,
        attempted_remote: remoteUrl || 'none',
        suggestion: 'Le fichier n\'existe pas localement et n\'est pas disponible sur les serveurs Forge/Mojang'
    });
});

// 4. API de téléchargement forcé
app.get('/api/download-forge-file', async (req, res) => {
    const { path: filePath, version = '1.20.1' } = req.query;
    
    if (!filePath) {
        return res.status(400).json({ error: 'Paramètre path manquant' });
    }
    
    const fileName = path.basename(filePath);
    let remoteUrl = null;
    
    // Déterminer l'URL Forge
    if (filePath.includes('forge-')) {
        remoteUrl = `${CONFIG.FORGE_MAVEN}/net/minecraftforge/forge/${version}/${fileName}`;
    } else if (filePath.includes('libraries/net/minecraftforge')) {
        remoteUrl = `${CONFIG.FORGE_MAVEN}/${filePath}`;
    } else if (fileName.includes('minecraft-forge')) {
        remoteUrl = `${CONFIG.FORGE_MAVEN_FALLBACK}/${filePath}`;
    }
    
    if (!remoteUrl) {
        return res.status(400).json({ error: 'Impossible de déterminer l\'URL Forge' });
    }
    
    console.log(`🔄 Téléchargement forcé Forge: ${remoteUrl}`);
    
    try {
        const cachePath = path.join(CONFIG.CACHE_DIR, 
            Buffer.from(remoteUrl).toString('base64').replace(/[^a-zA-Z0-9]/g, ''));
        
        const success = await downloadAndCache(remoteUrl, cachePath);
        
        if (success) {
            res.json({
                success: true,
                url: remoteUrl,
                cached_path: cachePath,
                size: fs.statSync(cachePath).size,
                download_url: `https://${req.get('host')}/files/instances/zendariom/${filePath}`
            });
        } else {
            res.status(500).json({ 
                success: false, 
                error: 'Échec du téléchargement' 
            });
        }
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// 5. Gestion du cache
app.get('/api/cache/info', (req, res) => {
    const cacheFiles = fs.readdirSync(CONFIG.CACHE_DIR);
    const stats = cacheFiles.map(file => {
        const filePath = path.join(CONFIG.CACHE_DIR, file);
        const stat = fs.statSync(filePath);
        return {
            file,
            size: stat.size,
            modified: stat.mtime,
            age: Date.now() - stat.mtimeMs
        };
    });
    
    res.json({
        cache_dir: CONFIG.CACHE_DIR,
        total_files: cacheFiles.length,
        total_size: stats.reduce((sum, s) => sum + s.size, 0),
        ttl: CONFIG.CACHE_TTL,
        files: stats
    });
});

app.delete('/api/cache/clear', (req, res) => {
    const cacheFiles = fs.readdirSync(CONFIG.CACHE_DIR);
    let deleted = 0;
    
    cacheFiles.forEach(file => {
        const filePath = path.join(CONFIG.CACHE_DIR, file);
        fs.unlinkSync(filePath);
        deleted++;
    });
    
    res.json({
        success: true,
        deleted_count: deleted,
        message: 'Cache vidé'
    });
});

// 6. Page d'accueil
app.get('/', (req, res) => {
    res.json({
        server: 'Zendarion Server - Fallback Forge/Mojang',
        version: '2.0',
        features: [
            '✅ Téléchargement automatique depuis Forge/Mojang',
            '🔄 Cache intelligent des fichiers',
            '📦 Support Forge 1.20.1+',
            '🔧 Placeholder pour natives',
            '🧹 Gestion du cache via API'
        ],
        endpoints: {
            config: `https://${req.get('host')}/files/instances.json`,
            files: `https://${req.get('host')}/files?instance=zendariom`,
            download_api: `https://${req.get('host')}/api/download-forge-file?path=forge-1.20.1-47.1.0-installer.jar`,
            cache_info: `https://${req.get('host')}/api/cache/info`,
            cache_clear: `https://${req.get('host')}/api/cache/clear`
        },
        stats: {
            cache_size: fs.readdirSync(CONFIG.CACHE_DIR).length,
            cache_dir: CONFIG.CACHE_DIR
        }
    });
});

// ================= DÉMARRAGE =================
app.listen(port, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║   ZENDARION SERVER - FALLBACK FORGE/MOJANG ACTIVÉ           ║
╚══════════════════════════════════════════════════════════════╝
📡 Port: ${port}
🌐 URL: https://zendarion-config.onrender.com
🎯 Target: Forge 1.20.1

🔗 Endpoints:
   📋 Config: https://zendarion-config.onrender.com/files/instances.json
   📁 Files:  https://zendarion-config.onrender.com/files?instance=zendariom
   ⬇️  Download API: https://zendarion-config.onrender.com/api/download-forge-file

🔄 Fonctionnalités:
   • Téléchargement auto depuis Forge/Mojang
   • Cache 24h des fichiers
   • Support natives Windows/Linux/Mac
   • Gestion fichiers temporaires (.x, .tmp)

💾 Cache: ${CONFIG.CACHE_DIR}
✅ Serveur prêt. Les fichiers manquants seront téléchargés automatiquement.
`);
});
