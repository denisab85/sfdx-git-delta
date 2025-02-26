'use strict'
const fileGitDiff = require('../utils/fileGitDiff')
const { MINUS, PLUS } = require('../utils/gitConstants')
const {
  LABEL_DIRECTORY_NAME,
  LABEL_EXTENSION,
} = require('../utils/metadataConstants')
const StandardHandler = require('./standardHandler')
const { outputFile } = require('fs-extra')
const { basename, join } = require('path')
const { XMLBuilder, XMLParser } = require('fast-xml-parser')

const FULLNAME = 'fullName'
const FULLNAME_XML_TAG = new RegExp(`<${FULLNAME}>(.*)</${FULLNAME}>`)
const XML_TAG = new RegExp(`^[${MINUS}${PLUS}]?\\s*<([^(/><.)]+)>\\s*$`)
const XML_HEADER_TAG_END = '?>'
const XML_PARSER_OPTION = {
  ignoreAttributes: false,
  ignoreNameSpace: false,
  parseTagValue: false,
  parseNodeValue: false,
  parseAttributeValue: false,
  trimValues: true,
}
const JSON_PARSER_OPTION = {
  ...XML_PARSER_OPTION,
  format: true,
  indentBy: '    ',
}

class InFileHandler extends StandardHandler {
  static xmlObjectToPackageType

  constructor(line, type, work, metadata) {
    super(line, type, work, metadata)
    this.parentMetadata = StandardHandler.metadata.get(this.type)
    this.customLabelElementName = `${basename(this.line).split('.')[0]}.`
    InFileHandler.xmlObjectToPackageType =
      InFileHandler.xmlObjectToPackageType ??
      [...StandardHandler.metadata.keys()]
        .filter(meta => !!StandardHandler.metadata.get(meta)?.xmlTag)
        .reduce(
          (acc, meta) =>
            acc.set(
              StandardHandler.metadata.get(meta).xmlTag,
              StandardHandler.metadata.get(meta)
            ),
          new Map()
        )
  }

  async handleAddition() {
    const addition = super.handleAddition()
    const toAdd = await this._handleInDiff()

    await this._handleFileWriting(toAdd)
    await addition
  }

  async handleDeletion() {
    await this._handleInDiff()
  }

  async handleModification() {
    await this.handleAddition()
  }

  async _handleFileWriting(toAdd) {
    if (!this.config.generateDelta) return
    const result = await this._parseFile()
    const metadataContent = Object.values(result.fileContent)[0]

    result.authorizedKeys.forEach(subType => {
      const meta = Array.isArray(metadataContent[subType])
        ? metadataContent[subType]
        : [metadataContent[subType]]
      metadataContent[subType] = meta.filter(elem =>
        toAdd
          .get(InFileHandler.xmlObjectToPackageType.get(subType).directoryName)
          ?.has(elem.fullName)
      )
    })
    const xmlBuilder = new XMLBuilder(JSON_PARSER_OPTION)
    const xmlContent = xmlBuilder.build(result.fileContent)
    await outputFile(
      join(this.config.output, this.line),
      xmlContent.replace(XML_HEADER_TAG_END, `${XML_HEADER_TAG_END}\n`)
    )
  }

  async _handleInDiff() {
    const data = {
      toDel: new Map(),
      toAdd: new Map(),
      potentialType: null,
      subType: null,
      fullName: null,
    }

    const diffContentIterator = fileGitDiff(this.line, this.config)
    for await (const line of diffContentIterator) {
      this._preProcessHandleInDiff(line, data)
      if (!data.subType || !data.fullName) continue
      this._postProcessHandleInDiff(line, data)
    }
    this._treatInFileResult(data.toDel, data.toAdd)
    return data.toAdd
  }

  _preProcessHandleInDiff(line, data) {
    if (FULLNAME_XML_TAG.test(line)) {
      data.fullName = line.match(FULLNAME_XML_TAG)[1]
      data.subType = `${this.parentMetadata.directoryName}.${data.potentialType}`
    }
    const xmlTagMatchResult = line.match(XML_TAG)
    if (InFileHandler._matchAllowedXmlTag(xmlTagMatchResult)) {
      data.potentialType = xmlTagMatchResult[1]
      data.fullName = null
    }
  }

  _postProcessHandleInDiff(line, data) {
    let tempMap
    if (line.startsWith(MINUS) && line.includes(FULLNAME)) {
      tempMap = data.toDel
    } else if (line.startsWith(PLUS) || line.startsWith(MINUS)) {
      tempMap = data.toAdd
    }
    if (tempMap) {
      if (!tempMap.has(data.subType)) {
        tempMap.set(data.subType, new Set())
      }
      tempMap.get(data.subType).add(data.fullName)
      data.subType = data.fullName = null
    }
  }

  _treatInFileResult(toRemove, toAdd) {
    for (const [type, members] of toRemove) {
      ;[...members]
        .filter(elem => !toAdd.has(type) || !toAdd.get(type).has(elem))
        .forEach(fullName =>
          this._fillPackageFromDiff(
            this.diffs.destructiveChanges,
            type,
            fullName
          )
        )
    }
    for (const [type, members] of toAdd) {
      for (let fullName of members) {
        this._fillPackageFromDiff(this.diffs.package, type, fullName)
      }
    }
  }

  async _parseFile() {
    const file = await this._readFile()
    const xmlParser = new XMLParser(XML_PARSER_OPTION)
    const result = xmlParser.parse(file)

    const authorizedKeys = Object.keys(Object.values(result)[0]).filter(tag =>
      InFileHandler.xmlObjectToPackageType.has(tag)
    )
    return {
      authorizedKeys: authorizedKeys,
      fileContent: result,
    }
  }

  _fillPackage(packageObject) {
    if (this.type !== LABEL_EXTENSION) {
      super._fillPackage(packageObject)
    }
  }

  _fillPackageFromDiff(packageObject, subType, value) {
    const elementFullName = `${
      (subType !== LABEL_DIRECTORY_NAME ? this.customLabelElementName : '') +
      value
    }`

    if (!packageObject.has(subType)) {
      packageObject.set(subType, new Set())
    }
    packageObject
      .get(subType)
      .add(StandardHandler.cleanUpPackageMember(elementFullName))
  }

  static _matchAllowedXmlTag(matchResult) {
    return (
      !!matchResult &&
      !!matchResult[1] &&
      InFileHandler.xmlObjectToPackageType.has(matchResult[1])
    )
  }
}

module.exports = InFileHandler
