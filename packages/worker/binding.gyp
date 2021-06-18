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
      'xcode_settings': {
        'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
        'CLANG_CXX_LIBRARY': 'libc++',
        'MACOSX_DEPLOYMENT_TARGET': '10.7'
      },
      'msvs_settings': {
        'VCCLCompilerTool': { 'ExceptionHandling': 1 },
      },
      'sources': [
        'workflow-isolate-extension.cc',
      ],
    },
  ],
}
