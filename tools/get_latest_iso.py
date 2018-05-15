#!/usr/bin/env python3

import os
import sys
from lxml import html
from urllib.parse import unquote
import requests

BASE_URL = 'https://downloads.vyos.io/'
PAGE_URL = BASE_URL+'?dir=rolling/current/amd64'


def download():
    page = requests.get(PAGE_URL)
    tree = html.fromstring(page.content)
    path = '//*[@id="directory-listing"]/li/a[1]/@href'
    isos = [x for x in tree.xpath(path) if os.path.splitext(x)[1] == '.iso']
    latest_iso_url = os.path.join(BASE_URL, isos[-1])
    filename = unquote(os.path.basename(latest_iso_url))
    print(filename)
    if os.path.exists(filename):
        print("{} already exists".format(filename))
        sys.exit(0)
    r = requests.get(latest_iso_url)
    with open(filename, 'wb') as fd:
        for chunk in r.iter_content(chunk_size=128):
            fd.write(chunk)


if __name__ == '__main__':
    download()
