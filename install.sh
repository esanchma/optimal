#!/usr/bin/env bash

systemctl --user stop optimal
cp optimal ~/.local/bin/optimal
systemctl --user start optimal
