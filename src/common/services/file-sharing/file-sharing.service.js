import { Injectable, Dependencies } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateKeys } from '../../utils/index';
import { FileDto } from '../../../files/dto/file.dto';
import { lookup } from 'mime-types';
import {
    existsSync,
    createWriteStream,
    createReadStream,
    writeFile,
    mkdir,
} from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { Readable } from 'stream';
import { getSavedFolderPathDetails } from '../../utils';

@Injectable()
@Dependencies(ConfigService)
export class FileSharingService {
    //local db of files {privateKey, publicKey, fileName}
    #configService;
    fileDto;

    constructor(configService) {
        this.#configService = configService;
    }

    //saves the file and return {privateKey, publicKey}
    async upload(file) {
        try {
            const { privateKey, publicKey } = generateKeys();
            const fileName = file.originalname;
            const folderName = this.#configService.get('FOLDER');
            let { absFilePath, dirPath, filesDbPath } = getSavedFolderPathDetails(
                fileName,
                folderName,
            );
            this.fileDto = new FileDto(fileName, publicKey, privateKey, absFilePath);

            let fileExists = existsSync(absFilePath);
            let dataDbExists = existsSync(filesDbPath);
            if (!fileExists && !dataDbExists) {
                await promisify(mkdir)(dirPath, {
                    recursive: true,
                });
                await promisify(writeFile)(absFilePath, '');
                await fs.writeFile(filesDbPath, JSON.stringify([]));
            }

            const fileWriteStream = createWriteStream(absFilePath);
            const fileReadStream = Readable.from([file.buffer]);

            return new Promise(async (resolve, reject) => {
                fileWriteStream.on('finish', async () => {
                    resolve({
                        privateKey,
                        publicKey,
                    });
                });

                //listen to error event and delegate to consumer
                fileWriteStream.on('error', (error) => {
                    reject(error);
                });

                fileReadStream.pipe(fileWriteStream);
                await this.updateJSON(
                    filesDbPath,
                    privateKey,
                    publicKey,
                    fileName,
                    absFilePath,
                );
            });
        } catch (error) {
            throw error;
        }
    }

    //download file by returning a file stream and tracking the download limit
    async downloadFile(userPublicKey, ipAddress) {
        try {
         

            let filePath = await this.getFilePath(userPublicKey);
            let usersDataDbPath = path.join(filePath, "..","..", "usersData");
            let filesDbPath = path.join(usersDataDbPath, "data.json")

            //  let fileExists = existsSync(userDataDbPath);
            let dataDbExists = existsSync(usersDataDbPath);
            if (!dataDbExists) {
                await promisify(mkdir)(usersDataDbPath, {
                    recursive: true,
                });
               
                await fs.writeFile(filesDbPath, JSON.stringify([]));
            }

         

            // Read existing data from file

            let data = await fs.readFile(filesDbPath);
            // let json = JSON.parse(data);
            let json = data.length > 0 ? JSON.parse(data) : [];
            // Check if private key already exists in JSON array
            
            let index = json.findIndex((item) => item["ipAddress"] == ipAddress);
            if (index === -1) {
                // If private key not found, append new object to JSON array
                let downloadLimit = this.#configService.get("DOWNLOAD_LIMIT")
                json.push({
                   
                    ipAddress,
                    downloadLimit
                });
            } else {
                if(json[index]["downloadLimit"] <= 0){
                    throw new Error("download limit reached!")
                }                   
                json[index]["downloadLimit"] = json[index]["downloadLimit"] - 1;
                
            }

            // Write updated data back to file
            await fs.writeFile(filesDbPath, JSON.stringify(json, null, 2));
          

           
            return await this.getFileStream(userPublicKey);
        } catch (error) {
            throw error;
        }
    }

    //deletion of file based on userPrivateKey
    async deleteFile(userPrivateKey) {
        try {
            const folderName = this.#configService.get('FOLDER');
            let filePath = await this.getFilePath(userPrivateKey);
            let fileName = path.basename(filePath);

            let { filesDbPath, dirPath } = getSavedFolderPathDetails(fileName, folderName);

            let filesLength = (await fs.readdir(dirPath)).length;
            if(filesLength.length == 1){
                await fs.rmdir(filesDbPath)
            }else{
                await fs.unlink(filePath );
                await this.deleteFromJSON(filesDbPath, userPrivateKey);

            }
            
            return "success"
        } catch (error) {
            throw error;
        }
    }

    //Validates user's user public key and returns a boolean
    async isValidPublicKey(userPublicKey) {
        const folderName = this.#configService.get('FOLDER');
        let filePath = await this.getFilePath(userPublicKey);
        if (!existsSync(filePath)) {
            throw new Error('file does not exist');
        }
        let fileName = path.basename(filePath);

        let { filesDbPath } = getSavedFolderPathDetails(fileName, folderName);

        let data = await fs.readFile(filesDbPath);
        let json = data.length > 0 ? JSON.parse(data) : [];

        for (let { publicKey } of json) {
            if (userPublicKey == publicKey) return true;
        }

        return false;
    }

    //Validates user's user private key and returns a boolean
    async isValidPrivateKey(userPrivateKey) {

        const folderName = this.#configService.get('FOLDER');
        let filePath = await this.getFilePath(userPrivateKey);
        if (!existsSync(filePath)) {
            throw new Error('file does not exist');
        }
        let fileName = path.basename(filePath);

        let { filesDbPath } = getSavedFolderPathDetails(fileName, folderName);

        let data = await fs.readFile(filesDbPath);
        let json = data.length > 0 ? JSON.parse(data) : [];

        for (let { privateKey } of json) {
            if (userPrivateKey == privateKey) {
                return true;
            }
        }

        return false;
    }

    async updateJSON(filesDbPath, privateKey, publicKey, fileName, filePath) {
        try {
            // Read existing data from file

            let data = await fs.readFile(filesDbPath);
            // let json = JSON.parse(data);
            let json = data.length > 0 ? JSON.parse(data) : [];
            // Check if private key already exists in JSON array
            
            let index = json.findIndex((item) => item.privateKey === privateKey);

            if (index === -1) {
                // If private key not found, append new object to JSON array
                json.push({
                    privateKey,
                    publicKey,
                    fileName,
                    filePath,
                });
            } else {
                json[index] = {
                    publicKey,
                    fileName,
                    privateKey,
                    filePath,
                };
            }

            // Write updated data back to file
            await fs.writeFile(filesDbPath, JSON.stringify(json, null, 2));
        } catch (error) {
            throw error;
        }
    }

    async deleteFromJSON(fileDbPath, privateKey) {
        try {
            // Read existing data from file
            let data = await fs.readFile(fileDbPath);
            let json = JSON.parse(data);

            // Find index of object with matching private key
            let index = json.findIndex((item) => item.privateKey === privateKey);

            if (index !== -1) {
                // If object with matching private key found, remove it from JSON array
                json.splice(index, 1);

                // Write updated data back to file
                await fs.writeFile(fileDbPath, JSON.stringify(json, null, 2));
            }
        } catch (error) {
            throw error;
        }
    }

    async getFileStream(userPublicKey) {
        // Check if file exists
        let filePath = await this.getFilePath(userPublicKey);
        if (!existsSync(filePath)) {
            throw new Error('file does not exist');
        }

        // Read file as a stream
        const fileStream = createReadStream(filePath);

        // Set the content type header
        const contentType = lookup(filePath);

        return {
            fileStream,
            contentType,
        };
    }

    //get file path based on either private or public key
    async getFilePath(key) {
        const folderName = this.#configService.get('FOLDER');

        const dirLevel = 4;
        const dirLevelArr = Array.from(
            {
                length: dirLevel,
            },
            (_) => '..',
        );
        const filesDbPath = path.join(
            __dirname,
            ...dirLevelArr,
            folderName,
            'data.json',
        );
        let data = await fs.readFile(filesDbPath);
        let json = data.length > 0 ? JSON.parse(data) : [];

        let fileInfo = {};

        for (let file of json) {
            if (key == file['privateKey'] || key == file['publicKey']) {
                fileInfo['filePath'] = file['filePath'];
            }
        }

        return fileInfo['filePath'];
    }
}
