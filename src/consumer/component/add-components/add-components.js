// @flow
import path from 'path';
import fs from 'fs-extra';
import R from 'ramda';
import format from 'string-format';
import assignwith from 'lodash.assignwith';
import groupby from 'lodash.groupby';
import unionBy from 'lodash.unionby';
import find from 'lodash.find';
import ignore from 'ignore';
import arrayDiff from 'array-difference';
import {
  glob,
  isDir,
  calculateFileInfo,
  existsSync,
  pathNormalizeToLinux,
  getMissingTestFiles,
  retrieveIgnoreList,
  pathJoinLinux,
  isAutoGeneratedFile
} from '../../../utils';
import { Consumer } from '../../../consumer';
import BitMap from '../../../consumer/bit-map';
import { BitId } from '../../../bit-id';
import type { BitIdStr } from '../../../bit-id/bit-id';
import { COMPONENT_ORIGINS, REGEX_PATTERN, DEFAULT_DIST_DIRNAME } from '../../../constants';
import logger from '../../../logger/logger';
import PathsNotExist from './exceptions/paths-not-exist';
import MissingComponentIdForImportedComponent from './exceptions/missing-id-imported-component';
import IncorrectIdForImportedComponent from './exceptions/incorrect-id-imported-component';
import NoFiles from './exceptions/no-files';
import DuplicateIds from './exceptions/duplicate-ids';
import EmptyDirectory from './exceptions/empty-directory';
import type { ComponentMapFile } from '../../../consumer/bit-map/component-map';
import type { PathLinux, PathOsBased } from '../../../utils/path';
import ComponentMap from '../../bit-map/component-map';

export type AddResult = { id: string, files: ComponentMapFile[] };
export type AddActionResults = { addedComponents: AddResult[], warnings: Object };
export type PathOrDSL = PathOsBased | string; // can be a path or a DSL, e.g: tests/{PARENT}/{FILE_NAME}
type PathsStats = { [string]: { isDir: boolean } };
type AddedComponent = {
  componentId: BitId,
  files: ComponentMapFile[],
  mainFile?: string,
  rootDir?: string // set only when one directory is added by author
};

/**
 * validatePaths - validate if paths entered by user exist and if not throw an error
 *
 * @param {string[]} fileArray - array of paths
 * @returns {PathsStats} componentPathsStats
 */
function validatePaths(fileArray: string[]): PathsStats {
  const componentPathsStats = {};
  fileArray.forEach((componentPath) => {
    if (!existsSync(componentPath)) {
      throw new PathsNotExist([componentPath]);
    }
    componentPathsStats[componentPath] = {
      isDir: isDir(componentPath)
    };
  });
  return componentPathsStats;
}

/**
 * validate that no two files where added with the same id in the same bit add command
 */
const validateNoDuplicateIds = (addComponents: Object[]) => {
  const duplicateIds = {};
  const newGroupedComponents = groupby(addComponents, 'componentId');
  Object.keys(newGroupedComponents).forEach((key) => {
    if (newGroupedComponents[key].length > 1) duplicateIds[key] = newGroupedComponents[key];
  });
  if (!R.isEmpty(duplicateIds) && !R.isNil(duplicateIds)) throw new DuplicateIds(duplicateIds);
};

export type AddProps = {
  componentPaths: PathOsBased[],
  id?: string,
  main?: PathOsBased,
  namespace?: string,
  tests: PathOrDSL[],
  exclude: PathOrDSL[],
  override: boolean
};

export default class AddComponents {
  consumer: Consumer;
  bitMap: BitMap;
  componentPaths: PathOsBased[];
  id: ?string; // id entered by the user
  main: ?PathOsBased;
  namespace: ?string;
  tests: PathOrDSL[];
  exclude: PathOrDSL[];
  override: boolean;
  warnings: Object;
  ignoreList: string[];
  gitIgnore: any;
  constructor(consumer: Consumer, addProps: AddProps) {
    this.consumer = consumer;
    this.bitMap = consumer.bitMap;
    this.componentPaths = addProps.componentPaths;
    this.id = addProps.id;
    this.main = addProps.main;
    this.namespace = addProps.namespace;
    this.tests = addProps.tests;
    this.exclude = addProps.exclude;
    this.override = addProps.override;
    this.warnings = {};
  }

  /**
   * @param {string[]} files - array of file-paths from which it should search for the dsl patterns.
   * @param {*} filesWithPotentialDsl - array of file-path which may have DSL patterns
   *
   * @returns array of file-paths from 'files' parameter that match the patterns from 'filesWithPotentialDsl' parameter
   */
  async getFilesAccordingToDsl(files: string[], filesWithPotentialDsl: PathOrDSL[]): Promise<PathLinux[]> {
    const filesListAllMatches = filesWithPotentialDsl.map(async (dsl) => {
      const filesListMatch = files.map(async (file) => {
        const fileInfo = calculateFileInfo(file);
        const generatedFile = format(dsl, fileInfo);
        const matches = await glob(generatedFile, { ignore: this.ignoreList });
        return matches.filter(match => fs.existsSync(match));
      });
      return Promise.all(filesListMatch);
    });
    const filesListFlatten = R.flatten(await Promise.all(filesListAllMatches));
    const filesListUnique = R.uniq(filesListFlatten);
    return filesListUnique.map((file) => {
      const relativeToConsumer = this.consumer.getPathRelativeToConsumer(file);
      return pathNormalizeToLinux(relativeToConsumer);
    });
  }

  addToBitMap({ componentId, files, mainFile, rootDir }: AddedComponent): AddResult {
    const componentMap: ComponentMap = this.bitMap.addComponent({
      componentId,
      files,
      mainFile,
      rootDir,
      origin: COMPONENT_ORIGINS.AUTHORED,
      override: this.override
    });
    return { id: componentId.toString(), files: componentMap.files };
  }

  /**
   * Add or update existing (imported and new) component according to bitmap
   * there are 3 options:
   * 1. a user is adding a new component. there is no record for this component in bit.map
   * 2. a user is updating an existing component. there is a record for this component in bit.map
   * 3. some or all the files of this component were previously added as another component-id.
   */
  addOrUpdateComponentInBitMap(component: AddedComponent): ?AddResult {
    const consumerPath = this.consumer.getPath();
    const includeSearchByBoxAndNameOnly = true;
    const shouldThrow = false;
    const parsedBitId = component.componentId;
    const files: ComponentMapFile[] = component.files;
    const foundComponentFromBitMap = this.bitMap.getComponent(
      component.componentId,
      shouldThrow,
      includeSearchByBoxAndNameOnly
    );
    component.files = files
      .map((file: ComponentMapFile) => {
        // $FlowFixMe null is removed later on
        if (isAutoGeneratedFile(path.join(consumerPath, file.relativePath))) return null;
        const existingIdOfFile = this.bitMap.getComponentIdByPath(file.relativePath);
        const idOfFileIsDifferent = existingIdOfFile && existingIdOfFile !== parsedBitId.toString();
        const existingComponentOfFile = existingIdOfFile ? this.bitMap.getComponent(existingIdOfFile) : undefined;
        const isImported =
          (foundComponentFromBitMap && foundComponentFromBitMap.origin === COMPONENT_ORIGINS.IMPORTED) ||
          (existingComponentOfFile && existingComponentOfFile.origin === COMPONENT_ORIGINS.IMPORTED);
        if (isImported) {
          // throw error in case user didn't add id to imported component or the id is incorrect
          if (!this.id) throw new MissingComponentIdForImportedComponent(parsedBitId.toStringWithoutVersion());
          if (idOfFileIsDifferent) {
            const existingIdWithoutVersion = BitId.parse(existingIdOfFile).toStringWithoutVersion();
            // $FlowFixMe $this.id is not null at this point
            throw new IncorrectIdForImportedComponent(existingIdWithoutVersion, this.id);
          }
          if (foundComponentFromBitMap) {
            const tempFile = path.relative(foundComponentFromBitMap.rootDir, file.relativePath);
            const foundFile = find(foundComponentFromBitMap.files, fileObject => fileObject.relativePath === tempFile);
            if (foundFile) {
              foundFile.relativePath = path.join(foundComponentFromBitMap.rootDir, foundFile.relativePath);
              return foundFile;
            }
          }
        } else if (idOfFileIsDifferent) {
          // not imported component file but exists in bitmap
          if (this.warnings[existingIdOfFile]) this.warnings[existingIdOfFile].push(file.relativePath);
          else this.warnings[existingIdOfFile] = [file.relativePath];
          // $FlowFixMe null is removed later on
          return null;
        }
        return file;
      })
      .filter(file => file);
    if (R.isEmpty(component.files)) return null;
    return this.addToBitMap(component);
  }

  // remove excluded files from file list
  async removeExcludedFiles(componentsWithFiles: AddedComponent[]) {
    const files = R.flatten(componentsWithFiles.map(x => x.files.map(i => i.relativePath)));
    const resolvedExcludedFiles = await this.getFilesAccordingToDsl(files, this.exclude);
    componentsWithFiles.forEach((componentWithFiles: AddedComponent) => {
      const mainFile = pathNormalizeToLinux(componentWithFiles.mainFile);
      if (resolvedExcludedFiles.includes(mainFile)) {
        componentWithFiles.files = [];
      } else {
        // if mainFile is excluded, exclude all files
        componentWithFiles.files = componentWithFiles.files.filter(
          key => !resolvedExcludedFiles.includes(key.relativePath)
        );
      }
    });
  }

  /**
   * if the id is already saved in bitmap file, it might have more data (such as scope, version)
   * use that id instead.
   */
  _getIdAccordingToExistingComponent(currentId: BitIdStr): BitId {
    const existingComponentId = this.bitMap.getExistingComponentId(currentId);
    const componentExists = !!existingComponentId;
    if (componentExists && this.bitMap.getComponent(existingComponentId).origin === COMPONENT_ORIGINS.NESTED) {
      throw new Error(`One of your dependencies (${existingComponentId}) has already the same namespace and name.
    If you're trying to add a new component, please choose a new namespace or name.
    If you're trying to update a dependency component, please re-import it individually`);
    }

    return existingComponentId ? BitId.parse(existingComponentId) : BitId.parse(currentId);
  }

  /**
   * used for updating main file if exists or doesn't exists
   */
  _addMainFileToFiles(files: ComponentMapFile[]): ?PathOsBased {
    let mainFile = this.main;
    if (mainFile && mainFile.match(REGEX_PATTERN)) {
      files.forEach((file) => {
        const fileInfo = calculateFileInfo(file.relativePath);
        const generatedFile = format(mainFile, fileInfo);
        const foundFile = R.find(R.propEq('relativePath', generatedFile))(files);
        if (foundFile) {
          mainFile = foundFile.relativePath;
        }
        if (fs.existsSync(generatedFile) && !foundFile) {
          files.push({ relativePath: generatedFile, test: false, name: path.basename(generatedFile) });
          mainFile = generatedFile;
        }
      });
    }
    if (!mainFile) return undefined;
    const mainFileRelativeToConsumer = this.consumer.getPathRelativeToConsumer(mainFile);
    const mainPath = path.join(this.consumer.getPath(), mainFileRelativeToConsumer);
    if (fs.existsSync(mainPath)) {
      return mainFileRelativeToConsumer;
    }
    return mainFile;
  }

  async _mergeTestFilesWithFiles(files: ComponentMapFile[]): Promise<ComponentMapFile[]> {
    const testFilesArr = !R.isEmpty(this.tests)
      ? await this.getFilesAccordingToDsl(files.map(file => file.relativePath), this.tests)
      : [];
    const resolvedTestFiles = testFilesArr.map(testFile => ({
      relativePath: testFile,
      test: true,
      name: path.basename(testFile)
    }));

    return unionBy(resolvedTestFiles, files, 'relativePath');
  }

  /**
   * given the component paths, prepare the id, mainFile and files to be added later on to bitmap
   * the id of the component is either entered by the user or, if not entered, concluded by the path.
   * e.g. bar/foo.js, the id would be bar/foo.
   * in case bitmap has already the same id, the complete id is taken from bitmap (see _getIdAccordingToExistingComponent)
   */
  async addOneComponent(componentPathsStats: PathsStats): Promise<AddedComponent> {
    let finalBitId: BitId; // final id to use for bitmap file
    if (this.id) {
      finalBitId = this._getIdAccordingToExistingComponent(this.id);
    }

    const componentsWithFilesP = await Object.keys(componentPathsStats).map(async (componentPath) => {
      if (componentPathsStats[componentPath].isDir) {
        const relativeComponentPath = this.consumer.getPathRelativeToConsumer(componentPath);
        const absoluteComponentPath = path.resolve(componentPath);
        const splitPath = absoluteComponentPath.split(path.sep);
        const lastDir = splitPath[splitPath.length - 1];
        const nameSpaceOrDir = this.namespace || splitPath[splitPath.length - 2];

        const matches = await glob(path.join(relativeComponentPath, '**'), {
          cwd: this.consumer.getPath(),
          nodir: true
        });

        const filteredMatches = this.gitIgnore.filter(matches);

        if (!filteredMatches.length) throw new EmptyDirectory();

        let files = filteredMatches.map((match: PathOsBased) => {
          return { relativePath: pathNormalizeToLinux(match), test: false, name: path.basename(match) };
        });

        // merge test files with files
        files = await this._mergeTestFilesWithFiles(files);
        const resolvedMainFile = this._addMainFileToFiles(files);

        if (!finalBitId) {
          const idFromPath = BitId.getValidBitId(nameSpaceOrDir, lastDir);
          finalBitId = this._getIdAccordingToExistingComponent(idFromPath.toString());
        }

        const rootDir = Object.keys(componentPathsStats).length === 1 ? relativeComponentPath : undefined;

        return { componentId: finalBitId, files, mainFile: resolvedMainFile, rootDir };
      }
      // is file
      const resolvedPath = path.resolve(componentPath);
      const pathParsed = path.parse(resolvedPath);
      const relativeFilePath = this.consumer.getPathRelativeToConsumer(componentPath);
      if (!finalBitId) {
        let dirName = pathParsed.dir;
        if (!dirName) {
          const absPath = path.resolve(componentPath);
          dirName = path.dirname(absPath);
        }
        const nameSpaceOrLastDir = this.namespace || R.last(dirName.split(path.sep));
        const idFromPath = BitId.getValidBitId(nameSpaceOrLastDir, pathParsed.name);
        finalBitId = this._getIdAccordingToExistingComponent(idFromPath.toString());
      }

      let files = [
        { relativePath: pathNormalizeToLinux(relativeFilePath), test: false, name: path.basename(relativeFilePath) }
      ];

      files = await this._mergeTestFilesWithFiles(files);
      const resolvedMainFile = this._addMainFileToFiles(files);
      return { componentId: finalBitId, files, mainFile: resolvedMainFile };
    });

    let componentsWithFiles: AddedComponent[] = await Promise.all(componentsWithFilesP);

    // remove files that are excluded
    if (!R.isEmpty(this.exclude)) await this.removeExcludedFiles(componentsWithFiles);

    const componentId = finalBitId;
    componentsWithFiles = componentsWithFiles.filter(componentWithFiles => componentWithFiles.files.length);

    if (componentsWithFiles.length === 0) return { componentId, files: [] };
    if (componentsWithFiles.length === 1) return componentsWithFiles[0];

    const files = componentsWithFiles.reduce((a, b) => {
      return a.concat(b.files);
    }, []);
    const groupedComponents = groupby(files, 'relativePath');
    const uniqComponents = Object.keys(groupedComponents).map(key =>
      assignwith({}, ...groupedComponents[key], (val1, val2) => val1 || val2)
    );
    return {
      componentId,
      files: uniqComponents,
      mainFile: R.head(componentsWithFiles).mainFile,
      rootDir: R.head(componentsWithFiles).rootDir
    };
  }

  getIgnoreList(): string[] {
    let ignoreList = retrieveIgnoreList(this.consumer.getPath());
    if (!this.consumer.bitJson.distTarget) {
      const importedComponents = this.bitMap.getAllComponents(COMPONENT_ORIGINS.IMPORTED);
      const distDirsOfImportedComponents = Object.keys(importedComponents).map(key =>
        pathJoinLinux(importedComponents[key].rootDir, DEFAULT_DIST_DIRNAME, '**')
      );
      ignoreList = ignoreList.concat(distDirsOfImportedComponents);
    }
    return ignoreList;
  }

  async add(): Promise<AddActionResults> {
    this.ignoreList = this.getIgnoreList();
    this.gitIgnore = ignore().add(this.ignoreList); // add ignore list

    // check unknown test files
    const missingFiles = getMissingTestFiles(this.tests);
    if (!R.isEmpty(missingFiles)) throw new PathsNotExist(missingFiles);

    let componentPathsStats = {};

    const resolvedComponentPathsWithoutGitIgnore = R.flatten(
      await Promise.all(this.componentPaths.map(componentPath => glob(componentPath)))
    );

    const resolvedComponentPathsWithGitIgnore = this.gitIgnore.filter(resolvedComponentPathsWithoutGitIgnore);

    // Run diff on both arrays to see what was filtered out because of the gitignore file
    const diff = arrayDiff(resolvedComponentPathsWithGitIgnore, resolvedComponentPathsWithoutGitIgnore);

    if (!R.isEmpty(this.tests) && this.id && R.isEmpty(resolvedComponentPathsWithoutGitIgnore)) {
      const resolvedTestFiles = R.flatten(await Promise.all(this.tests.map(componentPath => glob(componentPath))));
      componentPathsStats = validatePaths(resolvedTestFiles);
    } else {
      if (R.isEmpty(resolvedComponentPathsWithoutGitIgnore)) throw new PathsNotExist(this.componentPaths);
      if (!R.isEmpty(resolvedComponentPathsWithGitIgnore)) {
        componentPathsStats = validatePaths(resolvedComponentPathsWithGitIgnore);
      } else {
        throw new NoFiles(diff);
      }
    }
    // if a user entered multiple paths and entered an id, he wants all these paths to be one component
    // conversely, if a user entered multiple paths without id, he wants each dir as an individual component
    const isMultipleComponents = Object.keys(componentPathsStats).length > 1 && !this.id;
    const addedComponents: AddResult[] = [];
    if (isMultipleComponents) {
      logger.debug('bit add - multiple components');
      const testToRemove = !R.isEmpty(this.tests)
        ? await this.getFilesAccordingToDsl(Object.keys(componentPathsStats), this.tests)
        : [];
      testToRemove.forEach(test => delete componentPathsStats[path.normalize(test)]);
      const addedP = Object.keys(componentPathsStats).map((onePath) => {
        const oneComponentPathStat = { [onePath]: componentPathsStats[onePath] };
        return this.addOneComponent(oneComponentPathStat);
      });

      const added = await Promise.all(addedP);
      validateNoDuplicateIds(added);
      added.forEach((component) => {
        if (!R.isEmpty(component.files)) {
          const addedComponent = this.addOrUpdateComponentInBitMap(component);
          if (addedComponent) addedComponents.push(addedComponent);
        }
      });
    } else {
      logger.debug('bit add - one component');
      // when a user enters more than one directory, he would like to keep the directories names
      // so then when a component is imported, it will write the files into the original directories
      const addedOne = await this.addOneComponent(componentPathsStats);
      if (!R.isEmpty(addedOne.files)) {
        const addedResult = this.addOrUpdateComponentInBitMap(addedOne);
        if (addedResult) addedComponents.push(addedResult);
      }
    }
    await this.bitMap.write();
    return { addedComponents, warnings: this.warnings };
  }
}
