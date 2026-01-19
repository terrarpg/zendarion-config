const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const axios = require('axios');
const app = express();
const port = 3000;

// Configuration du domaine
const DOMAIN = 'https://zendarion-config.onrender.com';

// Configuration du renommage
const RENAME_CONFIG = {
    prefix: 'zendarion',
    format: '{prefix}_{counter}.jar',
    startCounter: 1,
    preserveOriginalNames: false // Si true, garde les noms originaux pour certains mods spéciaux
};

// Middleware pour servir les fichiers statiques
app.use('/files', express.static(path.join(__dirname, 'files')));

// Middleware pour parser JSON
app.use(express.json());

// Fonction pour renommer automatiquement les mods
function renameModFile(originalName, instancePath, instanceName) {
    const modsPath = path.join(instancePath, 'mods');
    
    // Lire les fichiers existants
    let existingFiles = [];
    if (fs.existsSync(modsPath)) {
        existingFiles = fs.readdirSync(modsPath)
            .filter(file => file.endsWith('.jar') && file.startsWith(RENAME_CONFIG.prefix));
    }
    
    // Déterminer le prochain numéro
    let nextCounter = RENAME_CONFIG.startCounter;
    if (existingFiles.length > 0) {
        // Extraire les numéros existants
        const numbers = existingFiles.map(file => {
            const match = file.match(/_(\d+)\.jar$/);
            return match ? parseInt(match[1]) : 0;
        }).filter(num => num > 0);
        
        if (numbers.length > 0) {
            nextCounter = Math.max(...numbers) + 1;
        }
    }
    
    // Générer le nouveau nom
    const newName = `${RENAME_CONFIG.prefix}_${nextCounter}.jar`;
    
    console.log(`Renommage: ${originalName} -> ${newName}`);
    return newName;
}

// Route pour la page d'accueil
app.get('/', (req, res) => res.send('Terra File Server OK - Mode Scan Complet avec Renommage Auto'));

// Route pour télécharger des mods avec renommage automatique
app.post('/download/mods', async (req, res) => {
    try {
        const { instance, urls } = req.body;
        
        if (!instance || !urls || !Array.isArray(urls) || urls.length === 0) {
            return res.status(400).json({ 
                error: 'Instance et liste d\'URLs de mods requis' 
            });
        }

        console.log(`Téléchargement de ${urls.length} mod(s) pour l'instance: ${instance}`);
        
        // Créer le chemin de l'instance
        const instancePath = path.join(__dirname, 'files', 'instances', instance);
        const modsPath = path.join(instancePath, 'mods');
        
        // Vérifier si l'instance existe
        if (!fs.existsSync(instancePath)) {
            return res.status(404).json({ error: 'Instance non trouvée' });
        }

        // Créer le dossier mods si nécessaire
        if (!fs.existsSync(modsPath)) {
            fs.mkdirSync(modsPath, { recursive: true });
        }

        const results = [];
        
        // Télécharger chaque mod
        for (let i = 0; i < urls.length; i++) {
            const modUrl = urls[i];
            
            try {
                console.log(`Téléchargement mod ${i+1}/${urls.length}: ${modUrl}`);
                
                // Extraire le nom original du fichier
                const originalName = path.basename(modUrl);
                const extension = path.extname(originalName);
                
                // Renommer automatiquement
                const newName = renameModFile(originalName, instancePath, instance);
                const destination = path.join(modsPath, newName);
                
                // Télécharger le mod
                const response = await axios({
                    method: 'GET',
                    url: modUrl,
                    responseType: 'stream',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': '*/*'
                    },
                    timeout: 60000 // 60 secondes timeout
                });

                // Sauvegarder le fichier
                const writer = fs.createWriteStream(destination);
                response.data.pipe(writer);

                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });

                // Vérifier la taille du fichier
                const stats = fs.statSync(destination);
                const fileSize = stats.size;
                
                // Ajouter aux résultats
                results.push({
                    originalName: originalName,
                    newName: newName,
                    path: `instances/${instance}/mods/${newName}`,
                    size: fileSize,
                    url: `${DOMAIN}/files/instances/${instance}/mods/${newName}`,
                    type: 'mod',
                    downloadUrl: `${DOMAIN}/download/mods/file/${instance}/${newName}`,
                    modified: new Date().toISOString(),
                    success: true
                });
                
                console.log(`Mod téléchargé et renommé: ${originalName} -> ${newName}`);
                
            } catch (error) {
                console.error(`Erreur téléchargement mod ${i+1}:`, error.message);
                results.push({
                    originalName: modUrl,
                    error: error.message,
                    success: false
                });
            }
        }

        // Retourner les résultats
        res.json({
            success: true,
            message: `Téléchargement de ${results.filter(r => r.success).length}/${urls.length} mod(s) terminé`,
            results: results
        });

    } catch (error) {
        console.error('Erreur téléchargement mods:', error);
        res.status(500).json({ 
            error: 'Erreur lors du téléchargement des mods',
            details: error.message 
        });
    }
});

// Route pour télécharger OptiFine (avec renommage spécial)
app.post('/download/optifine', async (req, res) => {
    try {
        const { instance, version = 'I6' } = req.body;
        
        if (!instance) {
            return res.status(400).json({ error: 'Nom de l\'instance requis' });
        }

        console.log(`Téléchargement OptiFine ${version} pour l'instance: ${instance}`);
        
        // Définir les versions d'OptiFine disponibles
        const optifineVersions = {
            'I3': { 
                filename: 'OptiFine_1.20.1_HD_U_I3.jar',
                url: 'https://optifine.net/adloadx?f=OptiFine_1.20.1_HD_U_I3.jar'
            },
            'I4': { 
                filename: 'OptiFine_1.20.1_HD_U_I4.jar',
                url: 'https://optifine.net/adloadx?f=OptiFine_1.20.1_HD_U_I4.jar'
            },
            'I5': { 
                filename: 'OptiFine_1.20.1_HD_U_I5.jar',
                url: 'https://optifine.net/adloadx?f=OptiFine_1.20.1_HD_U_I5.jar'
            },
            'I6': { 
                filename: 'OptiFine_1.20.1_HD_U_I6.jar',
                url: 'https://optifine.net/adloadx?f=OptiFine_1.20.1_HD_U_I6.jar'
            }
        };

        const optifineInfo = optifineVersions[version];
        if (!optifineInfo) {
            return res.status(400).json({ error: 'Version d\'OptiFine non supportée' });
        }

        // Créer le chemin de destination
        const instancePath = path.join(__dirname, 'files', 'instances', instance);
        const modsPath = path.join(instancePath, 'mods');
        
        // Vérifier si l'instance existe
        if (!fs.existsSync(instancePath)) {
            return res.status(404).json({ error: 'Instance non trouvée' });
        }

        // Créer le dossier mods si nécessaire
        if (!fs.existsSync(modsPath)) {
            fs.mkdirSync(modsPath, { recursive: true });
        }

        // Pour OptiFine, on garde un nom spécifique
        const optifineName = `zendarion_optifine_${version.toLowerCase()}.jar`;
        const destination = path.join(modsPath, optifineName);
        
        // Télécharger OptiFine
        console.log(`Téléchargement depuis: ${optifineInfo.url}`);
        console.log(`Destination: ${destination}`);
        
        const response = await axios({
            method: 'GET',
            url: optifineInfo.url,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*',
                'Referer': 'https://optifine.net/downloads'
            },
            timeout: 30000
        });

        // Sauvegarder le fichier
        const writer = fs.createWriteStream(destination);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                console.log(`OptiFine ${version} téléchargé avec succès!`);
                
                // Vérifier la taille du fichier
                const stats = fs.statSync(destination);
                const fileSize = stats.size;
                
                // Créer la réponse
                const fileInfo = {
                    originalName: optifineInfo.filename,
                    newName: optifineName,
                    path: `instances/${instance}/mods/${optifineName}`,
                    size: fileSize,
                    url: `${DOMAIN}/files/instances/${instance}/mods/${optifineName}`,
                    type: 'mod',
                    version: version,
                    isOptifine: true,
                    downloadUrl: `${DOMAIN}/download/optifine/file/${instance}/${optifineName}`,
                    modified: new Date().toISOString()
                };
                
                res.json({
                    success: true,
                    message: `OptiFine ${version} téléchargé et renommé avec succès!`,
                    file: fileInfo
                });
                resolve();
            });

            writer.on('error', (error) => {
                console.error('Erreur lors de l\'écriture du fichier:', error);
                res.status(500).json({ 
                    error: 'Erreur lors du téléchargement',
                    details: error.message 
                });
                reject(error);
            });
        });

    } catch (error) {
        console.error('Erreur téléchargement OptiFine:', error);
        res.status(500).json({ 
            error: 'Erreur lors du téléchargement d\'OptiFine',
            details: error.message 
        });
    }
});

// Route pour télécharger un fichier mod spécifique
app.get('/download/mods/file/:instance/:filename', (req, res) => {
    const { instance, filename } = req.params;
    const filePath = path.join(__dirname, 'files', 'instances', instance, 'mods', filename);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Fichier mod non trouvé' });
    }
    
    res.download(filePath, filename);
});

// Route pour télécharger le fichier OptiFine
app.get('/download/optifine/file/:instance/:filename', (req, res) => {
    const { instance, filename } = req.params;
    const filePath = path.join(__dirname, 'files', 'instances', instance, 'mods', filename);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Fichier OptiFine non trouvé' });
    }
    
    res.download(filePath, filename);
});

// Route pour renommer manuellement les mods existants
app.post('/rename/mods', (req, res) => {
    try {
        const { instance } = req.body;
        
        if (!instance) {
            return res.status(400).json({ error: 'Nom de l\'instance requis' });
        }
        
        const instancePath = path.join(__dirname, 'files', 'instances', instance);
        const modsPath = path.join(instancePath, 'mods');
        
        if (!fs.existsSync(modsPath)) {
            return res.json({ 
                success: true, 
                message: 'Aucun dossier mods trouvé',
                renamed: [] 
            });
        }
        
        // Lire tous les fichiers .jar
        const files = fs.readdirSync(modsPath)
            .filter(file => file.endsWith('.jar') && !file.startsWith(RENAME_CONFIG.prefix));
        
        const renamedFiles = [];
        let counter = RENAME_CONFIG.startCounter;
        
        // Déterminer le prochain numéro disponible
        const existingFiles = fs.readdirSync(modsPath)
            .filter(file => file.endsWith('.jar') && file.startsWith(RENAME_CONFIG.prefix));
        
        if (existingFiles.length > 0) {
            const numbers = existingFiles.map(file => {
                const match = file.match(/_(\d+)\.jar$/);
                return match ? parseInt(match[1]) : 0;
            }).filter(num => num > 0);
            
            if (numbers.length > 0) {
                counter = Math.max(...numbers) + 1;
            }
        }
        
        // Renommer les fichiers
        for (const file of files) {
            const oldPath = path.join(modsPath, file);
            const newName = `${RENAME_CONFIG.prefix}_${counter}.jar`;
            const newPath = path.join(modsPath, newName);
            
            // Vérifier si le nouveau nom existe déjà
            if (!fs.existsSync(newPath)) {
                fs.renameSync(oldPath, newPath);
                renamedFiles.push({
                    original: file,
                    new: newName
                });
                counter++;
            }
        }
        
        res.json({
            success: true,
            message: `${renamedFiles.length} mod(s) renommé(s)`,
            renamed: renamedFiles
        });
        
    } catch (error) {
        console.error('Erreur renommage mods:', error);
        res.status(500).json({ 
            error: 'Erreur lors du renommage',
            details: error.message 
        });
    }
});

// Route pour vérifier les mods renommés
app.get('/mods/renamed/:instance', (req, res) => {
    const instance = req.params.instance;
    const modsPath = path.join(__dirname, 'files', 'instances', instance, 'mods');
    
    if (!fs.existsSync(modsPath)) {
        return res.json({ 
            renamed: false,
            files: [],
            renamedFiles: [],
            originalFiles: []
        });
    }
    
    const allFiles = fs.readdirSync(modsPath)
        .filter(file => file.endsWith('.jar'));
    
    const renamedFiles = allFiles.filter(file => file.startsWith(RENAME_CONFIG.prefix));
    const originalFiles = allFiles.filter(file => !file.startsWith(RENAME_CONFIG.prefix));
    
    res.json({ 
        renamed: renamedFiles.length > 0,
        renamedFiles: renamedFiles,
        originalFiles: originalFiles,
        total: allFiles.length,
        renameConfig: RENAME_CONFIG
    });
});

// Route pour lister les versions d'OptiFine disponibles
app.get('/optifine/versions', (req, res) => {
    const versions = [
        { 
            id: 'I6', 
            name: 'OptiFine HD U I6',
            description: 'Version recommandée - la plus stable',
            recommended: true,
            minecraft: '1.20.1',
            forge: '47.4.15',
            renamedName: 'zendarion_optifine_i6.jar'
        },
        { 
            id: 'I5', 
            name: 'OptiFine HD U I5',
            description: 'Version alternative - très stable',
            recommended: false,
            minecraft: '1.20.1',
            forge: '47.4.15',
            renamedName: 'zendarion_optifine_i5.jar'
        },
        { 
            id: 'I4', 
            name: 'OptiFine HD U I4',
            description: 'Version antérieure',
            recommended: false,
            minecraft: '1.20.1',
            forge: '47.4.15',
            renamedName: 'zendarion_optifine_i4.jar'
        },
        { 
            id: 'I3', 
            name: 'OptiFine HD U I3',
            description: 'Version plus ancienne',
            recommended: false,
            minecraft: '1.20.1',
            forge: '47.4.15',
            renamedName: 'zendarion_optifine_i3.jar'
        }
    ];
    
    res.json({ versions });
});

// Route pour vérifier si OptiFine est déjà installé
app.get('/optifine/check/:instance', (req, res) => {
    const instance = req.params.instance;
    const modsPath = path.join(__dirname, 'files', 'instances', instance, 'mods');
    
    if (!fs.existsSync(modsPath)) {
        return res.json({ installed: false, files: [] });
    }
    
    const mods = fs.readdirSync(modsPath)
        .filter(file => file.includes('optifine') || file.includes('OptiFine'))
        .map(file => {
            const filePath = path.join(modsPath, file);
            const stats = fs.statSync(filePath);
            
            // Extraire la version du nom de fichier
            const versionMatch = file.match(/i\d+/i);
            const version = versionMatch ? versionMatch[0].toUpperCase() : 'unknown';
            
            return {
                filename: file,
                path: `instances/${instance}/mods/${file}`,
                size: stats.size,
                url: `${DOMAIN}/files/instances/${instance}/mods/${file}`,
                version: version,
                modified: stats.mtime,
                downloadUrl: `${DOMAIN}/download/optifine/file/${instance}/${file}`
            };
        });
    
    res.json({ 
        installed: mods.length > 0,
        files: mods 
    });
});

// Route pour supprimer un mod
app.delete('/mods/:instance/:filename', (req, res) => {
    const { instance, filename } = req.params;
    const filePath = path.join(__dirname, 'files', 'instances', instance, 'mods', filename);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Fichier non trouvé' });
    }
    
    try {
        fs.unlinkSync(filePath);
        res.json({ 
            success: true, 
            message: `Mod ${filename} supprimé avec succès` 
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Erreur lors de la suppression',
            details: error.message 
        });
    }
});

// Route PRINCIPALE - Scan COMPLET de l'instance
app.get('/files/', (req, res) => {
    const instanceName = req.query.instance;
    
    if (!instanceName) {
        return res.status(400).json([]);
    }
    
    const instancePath = path.join(__dirname, 'files', 'instances', instanceName);
    
    console.log(`Scan complet de l'instance: ${instanceName}`);
    console.log(`Chemin: ${instancePath}`);
    
    try {
        if (!fs.existsSync(instancePath)) {
            console.log(`Instance non trouvée: ${instancePath}`);
            return res.json([]);
        }

        // Fonction pour scanner RÉCURSIVEMENT tous les fichiers
        function scanAllFiles(dir, basePath = '') {
            let allFiles = [];
            
            try {
                const items = fs.readdirSync(dir);
                
                for (const item of items) {
                    const fullPath = path.join(dir, item);
                    const relativePath = path.join(basePath, item).replace(/\\/g, '/');
                    
                    try {
                        const stats = fs.statSync(fullPath);
                        
                        if (stats.isDirectory()) {
                            // Scanner récursivement le sous-dossier
                            const subFiles = scanAllFiles(fullPath, relativePath);
                            allFiles = allFiles.concat(subFiles);
                        } else {
                            // Déterminer le type de fichier
                            let fileType = 'file';
                            if (item.endsWith('.jar')) {
                                fileType = 'mod';
                            } else if (item.endsWith('.json')) {
                                fileType = 'config';
                            } else if (item.endsWith('.png') || item.endsWith('.jpg')) {
                                fileType = 'image';
                            }
                            
                            // Ajouter le fichier avec URL COMPLÈTE
                            allFiles.push({
                                name: item,
                                path: relativePath,
                                size: stats.size,
                                url: `${DOMAIN}/files/instances/${instanceName}/${relativePath}`,
                                type: fileType,
                                modified: stats.mtime,
                                isOptifine: item.includes('optifine') || item.includes('OptiFine'),
                                isRenamed: item.startsWith(RENAME_CONFIG.prefix)
                            });
                        }
                    } catch (error) {
                        console.log(`Erreur sur ${fullPath}:`, error.message);
                    }
                }
            } catch (error) {
                console.log(`Erreur lecture dossier ${dir}:`, error.message);
            }
            
            return allFiles;
        }

        // Scanner TOUS les fichiers de l'instance
        const allFiles = scanAllFiles(instancePath);
        
        console.log(`Total fichiers trouvés: ${allFiles.length}`);
        
        // Compter les mods renommés
        const renamedMods = allFiles.filter(f => f.type === 'mod' && f.isRenamed);
        console.log(`Mods renommés: ${renamedMods.length}`);
        
        res.json(allFiles);
        
    } catch (error) {
        console.error('Erreur scan complet:', error);
        res.status(500).json({ error: 'Erreur scan instance' });
    }
});

// Route pour télécharger n'importe quel fichier
app.get('/files/instances/:instance/*', (req, res) => {
    const instanceName = req.params.instance;
    const filePath = req.params[0];
    
    const fullPath = path.join(__dirname, 'files', 'instances', instanceName, filePath);
    
    console.log(`Demande fichier: ${filePath}`);
    
    try {
        if (!fs.existsSync(fullPath)) {
            console.log(`Fichier non trouvé: ${fullPath}`);
            return res.status(404).json({ error: 'Fichier non trouvé: ' + filePath });
        }
        
        // Servir le fichier
        res.sendFile(fullPath);
        
    } catch (error) {
        console.error('Erreur envoi fichier:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// Route pour lister les instances disponibles
app.get('/instances', (req, res) => {
    const instancesPath = path.join(__dirname, 'files', 'instances');
    
    try {
        if (!fs.existsSync(instancesPath)) {
            return res.json({ instances: [] });
        }
        
        const instances = fs.readdirSync(instancesPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
        
        res.json({ instances });
    } catch (error) {
        res.status(500).json({ error: 'Erreur lecture instances' });
    }
});

// Route pour obtenir les informations système
app.get('/system/info', (req, res) => {
    const systemInfo = {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        memory: {
            total: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`,
            used: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
        },
        uptime: `${Math.round(process.uptime())} secondes`,
        domain: DOMAIN,
        renameConfig: RENAME_CONFIG,
        features: {
            optifineDownload: true,
            autoRenameMods: true,
            fileScan: true,
            instanceManagement: true,
            bulkDownload: true
        }
    };
    
    res.json(systemInfo);
});

app.listen(port, () => {
    console.log(`=== Terra File Server Démaré ===`);
    console.log(`URL: http://localhost:${port}`);
    console.log(`Domaine public: ${DOMAIN}`);
    console.log(`Dossier instances: ${path.join(__dirname, 'files', 'instances')}`);
    console.log(`Mode: SCAN COMPLET avec RENOMMAGE AUTO`);
    console.log(`Préfixe renommage: ${RENAME_CONFIG.prefix}`);
    console.log(`Fonctionnalité OptiFine: ACTIVÉE`);
    console.log(`===========================================`);
    
    // Afficher les instances disponibles au démarrage
    const instancesPath = path.join(__dirname, 'files', 'instances');
    if (fs.existsSync(instancesPath)) {
        const instances = fs.readdirSync(instancesPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
        
        console.log(`Instances disponibles: ${instances.join(', ')}`);
        
        // Vérifier les mods installés pour chaque instance
        instances.forEach(instance => {
            const modsPath = path.join(instancesPath, instance, 'mods');
            if (fs.existsSync(modsPath)) {
                const mods = fs.readdirSync(modsPath);
                const renamedMods = mods.filter(mod => mod.startsWith(RENAME_CONFIG.prefix));
                if (renamedMods.length > 0) {
                    console.log(`  ${instance}: ${renamedMods.length} mod(s) renommé(s)`);
                }
            }
        });
    }
});
