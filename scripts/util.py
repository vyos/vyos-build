import sys
import os

import defaults

def check_build_config():
    if not os.path.exists(defaults.BUILD_CONFIG):
        print("Build config file ({file}) does not exist".format(file=defaults.BUILD_CONFIG))
        print("If you are running this script by hand, you should better not. Run 'make iso' instead.")
        sys.exit(1)
