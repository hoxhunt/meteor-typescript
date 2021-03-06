'use strict';

var assert = require("assert");
var ts = require("typescript");
var _ = require("underscore");

var getDefaultCompilerOptions = require("./options").getDefaultCompilerOptions;
var convertCompilerOptionsOrThrow = require("./options").convertCompilerOptionsOrThrow;
var validateTsConfig = require("./options").validateTsConfig;
var presetCompilerOptions = require("./options").presetCompilerOptions;
var CompileService = require("./compile-service").CompileService;
var createCSResult = require("./compile-service").createCSResult;
var ServiceHost = require("./compile-service-host").CompileServiceHost;
var sourceHost = require("./files-source-host").sourceHost;
var CompileCache = require("./cache").CompileCache;
var FileHashCache = require("./cache").FileHashCache;
var Logger = require("./logger").Logger;
var deepHash = require("./utils").deepHash;
var utils = require("./utils");
var tsu = require("./ts-utils").ts;

var compileCache, fileHashCache;
function setCacheDir(cacheDir) {
  if (compileCache && compileCache.cacheDir === cacheDir) {
    return;
  }

  compileCache = new CompileCache(cacheDir);
  fileHashCache = new FileHashCache(cacheDir);
};

exports.setCacheDir = setCacheDir;

function getConvertedDefault(arch) {
  return convertCompilerOptionsOrThrow(
    getDefaultCompilerOptions(arch));
}

function isES6Target(target) {
  return /es6/i.test(target) || /es2015/i.test(target);
};

function defaultCompilerOptions(arch, opt) {
  var defOpt = getDefaultCompilerOptions(arch);
  var resOpt = opt || defOpt;

  _.defaults(resOpt, defOpt);
  // Add target to the lib since
  // if target: "es6" and lib: ["es5"],
  // it won't compile properly.
  if (resOpt.target) {
    resOpt.lib.push(resOpt.target);
  }
  resOpt.lib = _.union(resOpt.lib, defOpt.lib);

  // Impose use strict for ES6 target.
  if (opt && opt.noImplicitUseStrict !== undefined) {
    if (isES6Target(resOpt.target)) {
      resOpt.noImplicitUseStrict = false;
    }
  }

  return resOpt;
}

var serviceHost;
function lazyInit() {
  if (! compileCache) {
    setCacheDir();
  }
}

// A map of TypeScript Language Services
// per each Meteor architecture.
var serviceMap = {};
function getCompileService(arch) {
  if (! arch) arch = "global";
  if (serviceMap[arch]) return serviceMap[arch];

  var serviceHost = new ServiceHost(fileHashCache);
  var service = new CompileService(serviceHost);
  serviceMap[arch] = service;
  return service;
}

/**
 * Class that represents an incremental TypeScript build (compilation).
 * For the typical usage in a Meteor compiler plugin,
 * see a TypeScript compiler that based on this NPM:
 * https://github.com/barbatus/typescript-compiler/blob/master/typescript-compiler.js#L58
 *
 * @param filePaths Paths of the files to compile.
 * @param getFileContent Method that takes a file path
 *  and returns that file's content. To be used to pass file contents
 *  from a Meteor compiler plugin to the TypeScript compiler.
 * @param options Object with the options of the TypeSctipt build.
 *   Available options:
 *    - compilerOptions: TypeScript compiler options
 *    - arch: Meteor file architecture
 *    - useCache: whether to use cache 
 */
class TSBuild {
  constructor(filePaths, getFileContent, options) {
    Logger.debug("new build");

    var arch = options && options.arch;
    var compilerOptions = options && options.compilerOptions;
    compilerOptions = defaultCompilerOptions(arch, compilerOptions);

    var resOptions = options || {};
    resOptions.compilerOptions = compilerOptions;

    resOptions = validateAndConvertOptions(resOptions);

    lazyInit();

    resOptions.compilerOptions = presetCompilerOptions(
      resOptions.compilerOptions);

    this.options = resOptions;

    sourceHost.setSource(getFileContent);

    var pset = Logger.newProfiler("set files");
    var compileService = getCompileService(resOptions.arch);
    var serviceHost = compileService.getHost();
    if (filePaths) {
      serviceHost.setFiles(filePaths, resOptions);
    }
    pset.end();
  }

  emit(filePath, moduleName) {
    Logger.debug("emit file %s", filePath);

    var options = this.options;
    var compileService = getCompileService(options.arch);

    var serviceHost = compileService.getHost();
    if (! serviceHost.hasFile(filePath))
      throw new Error("File " + filePath + " not found");

    var useCache = options && options.useCache;

    // Prepare file options which besides general ones
    // should contain a module name. Omit arch to avoid
    // re-compiling same files aimed for diff arch.
    var noArchOpts = _.omit(options, 'arch', 'useCache');
    var csOptions = {
      options: noArchOpts,
      moduleName: moduleName
    };

    function compile() {
      var pcomp = Logger.newProfiler("compile " + filePath);
      var result = compileService.compile(filePath, moduleName);
      pcomp.end();
      return result;
    }

    if (useCache === false) {
      var result = compile();
      compileCache.save(filePath, csOptions, result);
      return result;
    }

    var pget = Logger.newProfiler("compileCache get");
    var result = compileCache.get(filePath, csOptions, function(cacheResult) {
      if (! cacheResult) {
        Logger.debug("cache miss: %s", filePath);
        return compile();
      }

      var csResult = createCSResult(cacheResult);
      var tsDiag = csResult.diagnostics;

      var prefs = Logger.newProfiler("refs check");
      var refsChanged = isRefsChanged(serviceHost,
        filePath, csResult.dependencies);
      prefs.end();

      // Referenced files have changed, which may need recompilation in some cases.
      // See https://github.com/Urigo/angular2-meteor/issues/102#issuecomment-191411701
      if (refsChanged === RefsType.FILES) {
        Logger.debug("recompile: %s", filePath);
        return compile();
      }

      // Diagnostics re-evaluation.
      // First case: file is not changed but contains unresolved modules
      // error from previous build (some node modules might have installed).
      // Second case: dependency modules or typings have changed.
      var unresolved = tsDiag.hasUnresolvedModules();
      if (unresolved || refsChanged !== RefsType.NONE) {
        Logger.debug("diagnostics re-evaluation: %s", filePath);
        var pdiag = Logger.newProfiler("diags update");
        csResult.upDiagnostics(
          compileService.getDiagnostics(filePath));
        pdiag.end();
        return csResult;
      }

      // Cached result is up to date, no action required.
      Logger.debug("file from cached: %s", filePath);
      return null;
    });
    pget.end();

    return result;
  }
}

var RefsType = {
  NONE: 0,
  FILES: 1,
  MODULES: 2,
  TYPINGS: 3
};

function isRefsChanged(serviceHost, filePath, refs) {
  assert.ok(serviceHost);

  if (serviceHost.isTypingsChanged()) {
    return RefsType.TYPINGS;
  }

  function isFilesChanged(files) {
    if (! files) return false;

    var tLen = files.length;
    for (var i = 0; i < tLen; i++) {
      var path = files[i];
      if (serviceHost.isFileChanged(path)) {
        return true;
      }
    }
    return false;
  }

  if (refs) {
    var typings = refs.refTypings;
    if (isFilesChanged(typings)) {
      Logger.debug("referenced typings changed in %s", filePath);
      return RefsType.TYPINGS;
    }

    var files = refs.refFiles;
    if (isFilesChanged(files)) {
      Logger.debug("referenced files changed in %s", filePath);
      return RefsType.FILES;
    }

    var modules = refs.modules;
    if (isFilesChanged(modules)) {
      Logger.debug("imported module changed in %s", filePath);
      return RefsType.MODULES;
    }
  }

  return RefsType.NONE;
}

exports.TSBuild = TSBuild;

exports.compile = function compile(fileContent, options) {
  if (typeof fileContent !== "string") {
    throw new Error("fileContent should be a string");
  }

  var optPath = options && options.filePath;
  var moduleName = options && options.moduleName;

  if (! optPath) {
    optPath = deepHash(fileContent, options);
    var tsx = (options && options.compilerOptions && 
      options.compilerOptions.jsx);
    optPath += tsx ? ".tsx" : ".ts";
  }

  var getFileContent = function(filePath) {
    if (filePath === optPath) {
      return fileContent;
    }
  }

  var newBuild = new TSBuild([optPath], getFileContent, options);
  return newBuild.emit(optPath, moduleName);
};

var validOptions = {
  "compilerOptions": "Object",
  // Next three to be used mainly
  // in the compile method above.
  "filePath": "String",
  "moduleName": "String",
  "typings": "Array",
  "arch": "String",
  "useCache": "Boolean"
};
var validOptionsMsg = "Valid options are " +
  "compilerOptions, filePath, moduleName, and typings.";

function checkType(option, optionName) {
  if (! option) return true;

  return option.constructor.name === validOptions[optionName];
}

function validateAndConvertOptions(options) {
  if (! options) return null;

  // Validate top level options.
  for (var option in options) {
    if (options.hasOwnProperty(option)) {
      if (validOptions[option] === undefined) {
        throw new Error("Unknown option: " + option + ".\n" +
          validOptionsMsg);
      }

      if (! checkType(options[option], option)) {
        throw new Error(option + " should be of type " +
          validOptions[option]);
      }
    }
  }

  var resOptions = _.clone(options);
  // Validate and convert compilerOptions.
  if (options.compilerOptions) {
    resOptions.compilerOptions = convertCompilerOptionsOrThrow(
      options.compilerOptions);
  }

  return resOptions;
}

exports.validateAndConvertOptions = validateAndConvertOptions;

exports.validateTsConfig = validateTsConfig;

exports.getDefaultOptions = function getDefaultOptions(arch) {
  return {
    compilerOptions: getDefaultCompilerOptions(arch)
  }
}

exports.getExcludeRegExp = tsu.getExcludeRegExp;
