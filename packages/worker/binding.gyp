{
  'targets': [
    {
      'target_name': 'temporalio-workflow-isolate-extension',
      'include_dirs': [
        "<!(node -e \"require('nan').include\")",
        '<!(node -e "require(\'isolated-vm/include\')")',
      ],
      # see: https://github.com/nodejs/node-gyp/issues/17#issuecomment-3917672
      'cflags!': [ '-fno-exceptions' ],
      'cflags_cc!': [ '-fno-exceptions' ],
      'cflags_cc': [ '-std=c++14', '-g', '-Wno-unknown-pragmas' ],            
      'xcode_settings': {
        'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
        'CLANG_CXX_LIBRARY': 'libc++',
        'MACOSX_DEPLOYMENT_TARGET': '10.7'
      },
      'msvs_settings': {
        'VCCLCompilerTool': { 'ExceptionHandling': 1, 'AdditionalOptions': [ '/GR' ] },
      },
      'msvs_disabled_warnings': [
        4101, # Unreferenced local (msvc fires these for ignored exception)
        4068, # Unknown pragma
      ],
      'conditions': [
        [ 'OS == "win"', { 'defines': [ 'NOMSG', 'NOMINMAX', 'WIN32_LEAN_AND_MEAN' ] } ],
      ],      
      'sources': [
        'workflow-isolate-extension.cc',
      ],
    },
  ],
}
