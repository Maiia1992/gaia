

import { Readable, Writable } from 'stream'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { load as proxyquire } from 'proxyquire'

import { readStream } from '../../../src/server/utils'
import { DriverModel, DriverConstructor, PerformDeleteArgs } from '../../../src/server/driverModel'
import { ListFilesResult, PerformWriteArgs, WriteResult } from '../../../src/server/driverModel'
import AzDriver from '../../../src/server/drivers/AzDriver'
import S3Driver from '../../../src/server/drivers/S3Driver'
import GcDriver from '../../../src/server/drivers/GcDriver'
import DiskDriver from '../../../src/server/drivers/diskDriver'

type DataMap = {key: string, data: string, etag: string}[];

export const availableMockedDrivers: {[name: string]: () => {driverClass: DriverConstructor, dataMap: DataMap, config: any}} = {
  az: () => makeMockedAzureDriver(),
  aws: () => makeMockedS3Driver(),
  gc: () => makeMockedGcDriver(),
  disk: () => makeMockedDiskDriver()
};


export function makeMockedAzureDriver() {

  let config = {
    "azCredentials": {
      "accountName": "mock-azure",
      "accountKey": "mock-azure-key"
    },
    "bucket": "spokes"
  }

  const dataMap: DataMap = []
  const uploadStreamToBlockBlob = async (aborter, stream, blockBlobURL, bufferSize, maxBuffers, options) => {
    const buffer = await readStream(stream)
    dataMap.push({data: buffer.toString(), key: blockBlobURL.blobName, etag: "test" })
    return { eTag: "" }
  }

  const listBlobFlatSegment = (_, __, { prefix }) => {
    const items = dataMap
      .filter(x => x.key.startsWith(prefix))
      .map(x => { return {
        name: x.key,
        properties: {
          lastModified: new Date(),
          eTag: x.etag,
          contentLength: x.data.length,
          contentType: "?"
        }
      }})
    return { segment: { blobItems: items } }
  }

  const ContainerURL = {
    fromServiceURL: () => {
      return {
        create: () => null,
        listBlobFlatSegment: listBlobFlatSegment,
      }
    }
  }

  const fromBlobURL = (blobName: string) => {
    return {
      blobName,
      delete: () => {
        return Promise.resolve().then(() => {
          const newDataMap = dataMap.filter((d) => d.key !== blobName)
          if (newDataMap.length === dataMap.length) {
            const err: any = new Error()
            err.statusCode = 404
            throw err
          }
          dataMap.length = 0
          dataMap.push(...newDataMap)
        })
      }
    }
  }
  
  const driverClass = proxyquire('../../../src/server/drivers/AzDriver', {
    '@azure/storage-blob': {
      SharedKeyCredential: class { },
      ContainerURL: ContainerURL,
      StorageURL: { newPipeline: () => null },
      ServiceURL: class { },
      BlobURL: { fromContainerURL: (_, blobName) => blobName },
      BlockBlobURL: { fromBlobURL: fromBlobURL },
      Aborter: { none: null },
      uploadStreamToBlockBlob: uploadStreamToBlockBlob
    }
  }).default
  return { driverClass, dataMap, config }
}


export function makeMockedS3Driver() {
  let config : any = {
    "bucket": "spokes"
  }
  const dataMap: DataMap = []
  let bucketName = ''

  const S3Class = class {
    headBucket(options) {
      bucketName = options.Bucket
      return { promise: () => Promise.resolve() }
    }
    upload(options) {
      return {
        promise: async () => {
          if (options.Bucket != bucketName) {
            throw new Error(`Unexpected bucket name: ${options.Bucket}. Expected ${bucketName}`)
          }
          const buffer = await readStream(options.Body)
          dataMap.push({ data: buffer.toString(), key: options.Key, etag: "test" })
          return { 
            ETag: "test"
          }
        }
      }
    }
    headObject(options) {
      return {
        promise: () => {
          return Promise.resolve().then(() => {
            if (!dataMap.find((d) => d.key === options.Key)) {
              const err: any = new Error()
              err.statusCode = 404
              throw err
            }
          })
        }
      }
    }
    deleteObject(options) {
      return {
        promise: () => {
          return Promise.resolve().then(() => {
            const newDataMap = dataMap.filter((d) => d.key !== options.Key)
            dataMap.length = 0
            dataMap.push(...newDataMap)
          })
        }
      }
    }
    listObjectsV2(options) {
      return {
        promise: async () => {
          const contents = dataMap
            .filter((entry) => {
              return (entry.key.slice(0, options.Prefix.length) === options.Prefix)
            })
            .map((entry) => {
              return { Key: entry.key }
            })
          return { Contents: contents, IsTruncated: false }
        }
      }
    }
    listObjects(options) {
      return {
        promise: async () => {
          const contents = dataMap
            .filter((entry) => {
              return (entry.key.slice(0, options.Prefix.length) === options.Prefix)
            })
            .map((entry) => {
              return { Key: entry.key, ETag: entry.etag }
            })
          return { Contents: contents, IsTruncated: false }
        }
      }
    }
  }

  const driverClass = proxyquire('../../../src/server/drivers/S3Driver', {
    'aws-sdk/clients/s3': S3Class
  }).default
  return { driverClass, dataMap, config }
}

export function makeMockedGcDriver() {
  let config = {
    "bucket": "spokes"
  }

  const dataMap: DataMap = []
  let myName = ''

  const file = function (filename) {
    const createWriteStream = function() {
      return new MockWriteStream(dataMap, filename)
    }
    return { 
      createWriteStream, 
      delete: () => {
        return Promise.resolve().then(() => {
          const newDataMap = dataMap.filter((d) => d.key !== filename)
          if (newDataMap.length === dataMap.length) {
            const err: any = new Error()
            err.code = 404
            throw err
          }
          dataMap.length = 0
          dataMap.push(...newDataMap)
        })
      },
      metadata: {
        etag: "test"
      } 
    }
  }
  const exists = function () {
    return Promise.resolve([true])
  }
  const StorageClass = class {
    bucket(bucketName) {
      if (myName === '') {
        myName = bucketName
      } else {
        if (myName !== bucketName) {
          throw new Error(`Unexpected bucket name: ${bucketName}. Expected ${myName}`)
        }
      }
      return { file, exists, getFiles: this.getFiles }
    }

    getFiles(options, cb) {
      const files = dataMap
        .filter(entry => entry.key.startsWith(options.prefix))
        .map(entry => { return { name: entry.key, etag: entry.etag } })
      cb(null, files, null)
    }
  }

  const driverClass = proxyquire('../../../src/server/drivers/GcDriver', {
    '@google-cloud/storage': { Storage: StorageClass }
  }).default
  return { driverClass, dataMap, config }
}

export function makeMockedDiskDriver() {

  const dataMap: DataMap = []

  const tmpStorageDir = path.resolve(os.tmpdir(), `disktest-${Date.now()-Math.random()}`)
  fs.mkdirSync(tmpStorageDir)
  let config = { 
    bucket: "spokes", 
    readURL: "https://local/none",
    diskSettings: {
      storageRootDirectory: tmpStorageDir
    }
  }
  class DiskDriverWrapper extends DiskDriver {
    async performWrite(args: PerformWriteArgs) : Promise<WriteResult> {
      const result = await super.performWrite(args)
      const filePath = path.resolve(tmpStorageDir, args.storageTopLevel, args.path)
      const fileContent = fs.readFileSync(filePath, {encoding: 'utf8'})
      dataMap.push({ key: `${args.storageTopLevel}/${args.path}`, data: fileContent, etag: "test" })
      return result
    }
    async performDelete(args: PerformDeleteArgs): Promise<void> {
      await super.performDelete(args)
      const key = `${args.storageTopLevel}/${args.path}`
      const newDataMap = dataMap.filter((d) => d.key !== key)
      dataMap.length = 0
      dataMap.push(...newDataMap)
    }
  }

  const driverClass: DriverConstructor = DiskDriverWrapper
  return {driverClass, dataMap, config}
}

class MockWriteStream extends Writable {
  dataMap: DataMap
  filename: string
  data: string
  constructor(dataMap: DataMap, filename: string) {
    super({})
    this.dataMap = dataMap
    this.filename = filename
    this.data = ''
  }
  _write(chunk: any, encoding: any, callback: any) {
    this.data += chunk
    callback()
    return true
  }
  _final(callback: any) {
    this.dataMap.push({ data: this.data, key: this.filename, etag: "test" })
    callback()
  }
}
