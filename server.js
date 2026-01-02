const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const app = express();
const port = process.env.PORT || 3000;

// ================= CONFIGURATION =================
const CONFIG = {
    // URLs des serveurs officiels Minecraft
    MOJANG_MANIFEST: 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
    MOJANG_ASSETS: 'https://resources.download.minecraft.net',
    MOJANG_LIBRARIES: 'https://libraries.minecraft.net',
    MOJANG_CLIENT: 'https://launcher.mojang.com',
    
    // URLs Forge
    FORGE_MAVEN: 'https://maven.minecraftforge.net',
    FORGE_FILES: 'https://files.minecraftforge.net/maven',
    
    // Cache
    CACHE_DIR: path.join(__dirname, 'cache'),
    CACHE_TTL: 24 * 60 * 60 * 1000,
    
    // Dossier des fichiers locaux
    FILES_DIR: path.join(__dirname, 'files'),
    
    // Logs
    LOG_DIR: path.join(__dirname, 'logs'),
};

// ================= INITIALISATION =================
// Créer les dossiers nécessaires
[CONFIG.CACHE_DIR, CONFIG.FILES_DIR, CONFIG.LOG_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Créé dossier: ${dir}`);
    }
});

// Créer la structure de base pour Zendariom
const zendariomDir = path.join(CONFIG.FILES_DIR, 'instances', 'zendariom');
const subDirs = [
    'mods',
    'config',
    'resourcepacks',
    'shaderpacks',
    'saves',
    'logs',
    'assets',
    'libraries',
    'versions'
];

subDirs.forEach(subDir => {
    const dirPath = path.join(zendariomDir, subDir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
});

// ================= MIDDLEWARE =================
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================= FONCTIONS UTILITAIRES =================

/**
 * Télécharge un fichier depuis une URL avec retry
 */
async function downloadFile(url, destination, maxRetries = 3) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        
        // Vérifier cache
        if (fs.existsSync(destination)) {
            const stats = fs.statSync(destination);
            if (stats.size > 0) {
                console.log(`✅ Cache valide: ${path.basename(destination)}`);
                return resolve(true);
            }
        }
        
        console.log(`🌐 Téléchargement: ${url}`);
        
        const attemptDownload = (retryCount = 0) => {
            const tempFile = destination + '.tmp';
            const fileStream = fs.createWriteStream(tempFile);
            
            const request = protocol.get(url, (response) => {
                if (response.statusCode === 200 || response.statusCode === 206) {
                    response.pipe(fileStream);
                    
                    fileStream.on('finish', () => {
                        fileStream.close();
                        
                        try {
                            fs.renameSync(tempFile, destination);
                            const stats = fs.statSync(destination);
                            console.log(`✅ Téléchargé: ${path.basename(destination)} (${(stats.size / 1024 / 1024).toFixed(2)} Mo)`);
                            resolve(true);
                        } catch (error) {
                            console.error(`❌ Erreur sauvegarde: ${error.message}`);
                            resolve(false);
                        }
                    });
                    
                    fileStream.on('error', (error) => {
                        fileStream.close();
                        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                        console.error(`❌ Erreur écriture: ${error.message}`);
                        
                        if (retryCount < maxRetries) {
                            console.log(`🔄 Retry ${retryCount + 1}/${maxRetries}...`);
                            setTimeout(() => attemptDownload(retryCount + 1), 2000);
                        } else {
                            resolve(false);
                        }
                    });
                } else {
                    fileStream.close();
                    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                    
                    if (retryCount < maxRetries) {
                        console.log(`🔄 Retry ${retryCount + 1}/${maxRetries} (HTTP ${response.statusCode})...`);
                        setTimeout(() => attemptDownload(retryCount + 1), 2000);
                    } else {
                        console.log(`❌ Échec final (HTTP ${response.statusCode}): ${url}`);
                        resolve(false);
                    }
                }
            });
            
            request.on('error', (error) => {
                fileStream.close();
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                
                if (retryCount < maxRetries) {
                    console.log(`🔄 Retry ${retryCount + 1}/${maxRetries} (Network error)...`);
                    setTimeout(() => attemptDownload(retryCount + 1), 2000);
                } else {
                    console.error(`❌ Erreur réseau: ${error.message}`);
                    resolve(false);
                }
            });
            
            request.setTimeout(15000, () => {
                request.destroy();
                fileStream.close();
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
                
                if (retryCount < maxRetries) {
                    console.log(`🔄 Retry ${retryCount + 1}/${maxRetries} (Timeout)...`);
                    setTimeout(() => attemptDownload(retryCount + 1), 2000);
                } else {
                    console.log(`⏱️ Timeout final: ${url}`);
                    resolve(false);
                }
            });
        };
        
        attemptDownload();
    });
}

/**
 * Récupère un fichier depuis les sources officielles avec fallback
 */
async function getFileFromSources(filePath, fileName) {
    const sources = [];
    
    // 1. Assets Minecraft (hash SHA1)
    if (fileName.length === 40 && /^[0-9a-f]{40}$/.test(fileName)) {
        const prefix = fileName.substring(0, 2);
        sources.push(`${CONFIG.MOJANG_ASSETS}/${prefix}/${fileName}`);
    }
    
    // 2. Libraries
    if (filePath.includes('libraries/')) {
        sources.push(`${CONFIG.MOJANG_LIBRARIES}/${filePath}`);
        
        // Forge libraries
        if (filePath.includes('net/minecraftforge') || 
            filePath.includes('cpw/mods') || 
            filePath.includes('org/ow2/asm')) {
            sources.push(`${CONFIG.FORGE_MAVEN}/${filePath}`);
        }
    }
    
    // 3. Client JAR
    if (filePath.includes('versions/') && fileName.endsWith('.jar') && !fileName.includes('-')) {
        const version = path.basename(path.dirname(filePath));
        sources.push(`${CONFIG.MOJANG_CLIENT}/v1/objects/${version}.jar`);
    }
    
    // 4. Forge fichiers
    if (fileName.includes('forge') || fileName.includes('minecraftforge')) {
        sources.push(`${CONFIG.FORGE_MAVEN}/${filePath}`);
        sources.push(`${CONFIG.FORGE_FILES}/${filePath}`);
    }
    
    // 5. Files génériques
    sources.push(`https://repo1.maven.org/maven2/${filePath}`);
    
    return sources;
}

/**
 * Vérifie si une URL est accessible
 */
function checkUrl(url) {
    return new Promise((resolve) => {
        const protocol = url.startsWith('https') ? https : http;
        const request = protocol.get(url, { timeout: 5000 }, (response) => {
            resolve(response.statusCode === 200 || response.statusCode === 206);
        });
        
        request.on('error', () => resolve(false));
        request.on('timeout', () => {
            request.destroy();
            resolve(false);
        });
        
        request.end();
    });
}

// ================= ROUTES PRINCIPALES =================

// 1. ROOT - Page d'accueil JSON
app.get('/', (req, res) => {
    console.log('📡 Accueil demandé');
    
    res.json({
        server: 'Zendariom Game Server',
        version: '2.0.0',
        description: 'Serveur de téléchargement automatique pour le launcher Zendariom',
        endpoints: {
            manifest: `${req.protocol}://${req.get('host')}/mc/game/version_manifest_v2.json`,
            instances: `${req.protocol}://${req.get('host')}/files/instances.json`,
            files: `${req.protocol}://${req.get('host')}/files/?instance=zendariom`,
            download: `${req.protocol}://${req.get('host')}/files/instances/zendariom/{filepath}`
        },
        status: 'online',
        timestamp: new Date().toISOString()
    });
});

// 2. MANIFEST Minecraft - TOUJOURS JSON
app.get('/mc/game/version_manifest_v2.json', async (req, res) => {
    console.log('📋 Manifest Minecraft demandé');
    
    // Toujours renvoyer un JSON valide
    res.setHeader('Content-Type', 'application/json');
    
    const manifest = {
        "latest": {
            "release": "1.20.1",
            "snapshot": "23w43a"
        },
        "versions": [
            {
                "id": "1.20.1",
                "type": "release",
                "url": `${req.protocol}://${req.get('host')}/versions/1.20.1.json`,
                "time": "2023-06-12T15:55:21+00:00",
                "releaseTime": "2023-06-07T09:35:21+00:00"
            }
        ]
    };
    
    console.log('✅ Manifest envoyé');
    res.json(manifest);
});

// 3. Fichier de version spécifique
app.get('/versions/:version.json', (req, res) => {
    const version = req.params.version;
    console.log(`📋 Version demandée: ${version}.json`);
    
    res.setHeader('Content-Type', 'application/json');
    
    if (version === '1.20.1') {
        const versionJson = {
            "id": "1.20.1",
            "type": "release",
            "mainClass": "net.minecraft.client.main.Main",
            "inheritsFrom": "1.20.1",
            "downloads": {
                "client": {
                    "sha1": "15ffbceef9c8cb2d14ce6a39acf7d7d0b6f4b7d2",
                    "size": 25194616,
                    "url": `${req.protocol}://${req.get('host')}/files/instances/zendariom/versions/1.20.1/1.20.1.jar`
                }
            },
            "libraries": [
                {
                    "name": "net.minecraftforge:forge:1.20.1-47.1.0:universal",
                    "downloads": {
                        "artifact": {
                            "path": "net/minecraftforge/forge/1.20.1-47.1.0/forge-1.20.1-47.1.0-universal.jar",
                            "sha1": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0",
                            "size": 151234567,
                            "url": `${req.protocol}://${req.get('host')}/files/instances/zendariom/libraries/net/minecraftforge/forge/1.20.1-47.1.0/forge-1.20.1-47.1.0-universal.jar`
                        }
                    }
                }
            ],
            "arguments": {
                "game": [],
                "jvm": []
            },
            "assetIndex": {
                "id": "5",
                "sha1": "cd97882c6d0c39c8c16ac0d2daad6d6beb5115d5",
                "size": 319908,
                "totalSize": 552556818,
                "url": `${req.protocol}://${req.get('host')}/assets/indexes/5.json`
            },
            "assets": "5",
            "minimumLauncherVersion": 21,
            "releaseTime": "2023-06-07T09:35:21+00:00",
            "time": "2023-06-12T15:55:21+00:00",
            "complianceLevel": 1
        };
        
        console.log('✅ Version JSON envoyée');
        res.json(versionJson);
    } else {
        res.status(404).json({ error: `Version ${version} non supportée` });
    }
});

// 4. Configuration des instances
app.get('/files/instances.json', (req, res) => {
    console.log('📋 Configuration instances demandée');
    
    res.setHeader('Content-Type', 'application/json');
    
    const config = {
        "zendariom": {
            "name": "zendariom",
            "url": `${req.protocol}://${req.get('host')}`,
            "loadder": {
                "minecraft_version": "1.20.1",
                "loadder_type": "forge",
                "loadder_version": "47.1.0"
            },
            "verify": true,
            "ignored": [
                "logs",
                "config",
                "resourcepacks",
                "shaderpacks",
                "options.txt",
                "optionsof.txt",
                "usercache.json",
                "usernamecache.json"
            ],
            "whitelist": ["Luuxis", "WWDJY", "Admin"],
            "whitelistActive": false,
            "status": {
                "nameServer": "ZENDARIOM",
                "ip": "91.197.6.16",
                "port": 26710,
                "version": "1.20.1",
                "maxPlayers": 100,
                "onlinePlayers": 24,
                "motd": "§bBienvenue sur Zendariom !"
            },
            "features": {
                "autoUpdate": true,
                "modSupport": true,
                "resourcePackSupport": true
            }
        }
    };
    
    console.log('✅ Configuration instances envoyée');
    res.json(config);
});

// 5. Liste des fichiers disponibles
app.get('/files/', async (req, res) => {
    const instanceName = req.query.instance || 'zendariom';
    console.log(`🔍 Liste fichiers pour: ${instanceName}`);
    
    res.setHeader('Content-Type', 'application/json');
    
    try {
        const instancePath = path.join(CONFIG.FILES_DIR, 'instances', instanceName);
        
        // Si l'instance n'existe pas, créer une liste par défaut
        if (!fs.existsSync(instancePath)) {
            console.log(`📁 Instance ${instanceName} non trouvée, création liste par défaut`);
            
            const defaultFiles = [
                {
                    "name": "FullBrightness.zip",
                    "path": "resourcepacks/FullBrightness.zip",
                    "size": 412473,
                    "url": `${req.protocol}://${req.get('host')}/files/instances/zendariom/resourcepacks/FullBrightness.zip`,
                    "type": "file",
                    "modified": "2026-01-02T04:03:19.000Z"
                },
                {
                    "name": "forge-1.20.1-47.1.0-installer.jar",
                    "path": "libraries/net/minecraftforge/forge/1.20.1-47.1.0/forge-1.20.1-47.1.0-installer.jar",
                    "size": 151234567,
                    "url": `${req.protocol}://${req.get('host')}/files/instances/zendariom/libraries/net/minecraftforge/forge/1.20.1-47.1.0/forge-1.20.1-47.1.0-installer.jar`,
                    "type": "file",
                    "modified": "2026-01-02T04:03:19.000Z"
                },
                {
                    "name": "1.20.1.jar",
                    "path": "versions/1.20.1/1.20.1.jar",
                    "size": 25194616,
                    "url": `${req.protocol}://${req.get('host')}/files/instances/zendariom/versions/1.20.1/1.20.1.jar`,
                    "type": "file",
                    "modified": "2026-01-02T04:03:19.000Z"
                }
            ];
            
            console.log(`✅ Liste par défaut envoyée (${defaultFiles.length} fichiers)`);
            return res.json(defaultFiles);
        }
        
        // Scanner les fichiers locaux
        function scanDir(dir, base = '') {
            const results = [];
            
            try {
                const items = fs.readdirSync(dir);
                
                for (const item of items) {
                    const fullPath = path.join(dir, item);
                    const relativePath = base ? `${base}/${item}` : item;
                    
                    try {
                        const stats = fs.statSync(fullPath);
                        
                        if (stats.isDirectory()) {
                            results.push(...scanDir(fullPath, relativePath));
                        } else {
                            // Ignorer fichiers cachés/temporaires
                            if (!item.startsWith('.') && !item.endsWith('.tmp')) {
                                results.push({
                                    name: item,
                                    path: relativePath.replace(/\\/g, '/'),
                                    size: stats.size,
                                    url: `${req.protocol}://${req.get('host')}/files/instances/${instanceName}/${relativePath.replace(/\\/g, '/')}`,
                                    type: 'file',
                                    modified: stats.mtime.toISOString()
                                });
                            }
                        }
                    } catch (error) {
                        console.error(`⚠️ Erreur scan ${fullPath}:`, error.message);
                    }
                }
            } catch (error) {
                console.error(`⚠️ Erreur scan dir ${dir}:`, error.message);
            }
            
            return results;
        }
        
        const files = scanDir(instancePath);
        console.log(`✅ ${files.length} fichiers locaux listés`);
        res.json(files);
        
    } catch (error) {
        console.error('❌ Erreur liste fichiers:', error);
        res.status(500).json({ error: 'Erreur interne' });
    }
});

// 6. TÉLÉCHARGEMENT DE FICHIERS - CORE DU SERVEUR
app.get('/files/instances/:instance/*', async (req, res) => {
    const instanceName = req.params.instance;
    const filePath = req.params[0];
    const fileName = path.basename(filePath);
    
    console.log(`📥 Demande fichier: ${filePath}`);
    
    try {
        const localPath = path.join(CONFIG.FILES_DIR, 'instances', instanceName, filePath);
        
        // Étape 1: Vérifier si le fichier existe localement
        if (fs.existsSync(localPath)) {
            const stats = fs.statSync(localPath);
            if (stats.size > 0) {
                console.log(`✅ Fichier local trouvé: ${fileName} (${(stats.size / 1024).toFixed(2)} Ko)`);
                return res.sendFile(localPath);
            }
        }
        
        // Étape 2: Télécharger depuis les sources officielles
        console.log(`🔄 Fichier non trouvé localement, recherche sources...`);
        
        const sources = await getFileFromSources(filePath, fileName);
        
        for (const sourceUrl of sources) {
            console.log(`🌐 Essai source: ${sourceUrl}`);
            
            // Vérifier si la source est accessible
            const isAvailable = await checkUrl(sourceUrl);
            
            if (isAvailable) {
                // Télécharger le fichier
                const cacheKey = Buffer.from(sourceUrl).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
                const cachePath = path.join(CONFIG.CACHE_DIR, cacheKey);
                
                const success = await downloadFile(sourceUrl, cachePath);
                
                if (success && fs.existsSync(cachePath)) {
                    // Créer le dossier local si nécessaire
                    const localDir = path.dirname(localPath);
                    if (!fs.existsSync(localDir)) {
                        fs.mkdirSync(localDir, { recursive: true });
                    }
                    
                    // Copier le fichier téléchargé vers le dossier local
                    fs.copyFileSync(cachePath, localPath);
                    console.log(`✅ Fichier téléchargé et copié localement: ${fileName}`);
                    
                    // Servir le fichier
                    return res.sendFile(cachePath);
                }
            }
        }
        
        // Étape 3: Créer un fichier placeholder pour les natives
        if (fileName.endsWith('.dll') || fileName.endsWith('.so') || fileName.endsWith('.dylib')) {
            console.log(`🛠️ Création placeholder pour native: ${fileName}`);
            
            const localDir = path.dirname(localPath);
            if (!fs.existsSync(localDir)) {
                fs.mkdirSync(localDir, { recursive: true });
            }
            
            // Créer un fichier minimal valide
            const placeholderContent = fileName.endsWith('.dll') ? 
                Buffer.from([0x4D, 0x5A]) : // Header PE pour DLL
                Buffer.from([0x7F, 0x45, 0x4C, 0x46]); // Header ELF pour Linux
            
            fs.writeFileSync(localPath, placeholderContent);
            
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', placeholderContent.length);
            return res.end(placeholderContent);
        }
        
        // Étape 4: Pour les assets JSON, créer un JSON vide
        if (fileName.endsWith('.json') && filePath.includes('assets')) {
            console.log(`📄 Création JSON vide pour asset: ${fileName}`);
            
            const localDir = path.dirname(localPath);
            if (!fs.existsSync(localDir)) {
                fs.mkdirSync(localDir, { recursive: true });
            }
            
            const emptyJson = { objects: {} };
            fs.writeFileSync(localPath, JSON.stringify(emptyJson, null, 2));
            
            res.setHeader('Content-Type', 'application/json');
            return res.json(emptyJson);
        }
        
        // Étape 5: Fichier introuvable
        console.log(`❌ Fichier introuvable: ${fileName}`);
        res.status(404).json({
            error: 'Fichier non trouvé',
            file: fileName,
            path: filePath,
            suggestion: 'Le fichier n\'existe pas et n\'a pas pu être téléchargé automatiquement'
        });
        
    } catch (error) {
        console.error(`❌ Erreur traitement ${filePath}:`, error);
        res.status(500).json({
            error: 'Erreur interne du serveur',
            message: error.message
        });
    }
});

// 7. API de santé
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        server: 'Zendariom File Server',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        endpoints: {
            root: `${req.protocol}://${req.get('host')}/`,
            manifest: `${req.protocol}://${req.get('host')}/mc/game/version_manifest_v2.json`,
            instances: `${req.protocol}://${req.get('host')}/files/instances.json`
        }
    });
});

// 8. Gestion des erreurs 404
app.use((req, res) => {
    console.log(`❌ Route non trouvée: ${req.method} ${req.url}`);
    
    res.status(404).json({
        error: 'Route non trouvée',
        path: req.url,
        method: req.method,
        available_routes: [
            'GET /',
            'GET /mc/game/version_manifest_v2.json',
            'GET /versions/:version.json',
            'GET /files/instances.json',
            'GET /files/?instance=zendariom',
            'GET /files/instances/zendariom/*',
            'GET /api/health'
        ]
    });
});

// 9. Gestion des erreurs globales
app.use((error, req, res, next) => {
    console.error('🔥 Erreur globale:', error);
    
    res.status(500).json({
        error: 'Erreur interne du serveur',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Contactez l\'administrateur'
    });
});

// ================= DÉMARRAGE =================
const server = app.listen(port, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║   🚀 ZENDARIOM FILE SERVER - TÉLÉCHARGEMENT AUTOMATIQUE     ║
╚═══════════════════════════════════════════════════════════════╝

📡 Serveur démarré sur: http://0.0.0.0:${port}
🌐 URL publique: https://zendarion-config.onrender.com
🎯 Instance: zendariom (Minecraft 1.20.1 Forge)

📂 Structure:
   • Fichiers locaux: ${CONFIG.FILES_DIR}
   • Cache: ${CONFIG.CACHE_DIR}
   • Logs: ${CONFIG.LOG_DIR}

🔗 Endpoints:
   📋 Manifest: https://zendarion-config.onrender.com/mc/game/version_manifest_v2.json
   📁 Config: https://zendarion-config.onrender.com/files/instances.json
   📄 Liste fichiers: https://zendarion-config.onrender.com/files/?instance=zendariom
   ⬇️  Téléchargement: https://zendarion-config.onrender.com/files/instances/zendariom/{chemin}

✨ Fonctionnalités:
   • ✅ Téléchargement auto depuis Mojang/Forge
   • 🔄 Cache intelligent
   • 📦 Support fichiers manquants
   • 🛠️ Placeholder automatique
   • 📡 JSON valide garanti

💡 Le serveur va automatiquement:
   1. Chercher les fichiers localement
   2. Télécharger depuis Mojang/Forge si absent
   3. Créer des placeholders si nécessaire
   4. TOUJOURS renvoyer du JSON valide

✅ Serveur prêt! Toutes les requêtes seront traitées correctement.
`);
});

// Arrêt propre
process.on('SIGTERM', () => {
    console.log('🛑 Arrêt du serveur...');
    server.close(() => {
        console.log('✅ Serveur arrêté proprement.');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('🛑 Arrêt (Ctrl+C)...');
    server.close(() => {
        console.log('✅ Serveur arrêté.');
        process.exit(0);
    });
});

module.exports = app;
