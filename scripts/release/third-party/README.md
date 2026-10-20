# Native library sources and licenses

The unchanged sharp 0.35.5 / sharp-libvips 1.3.4 binaries are provided as separate dynamic libraries. Their package README notices and versions.json are preserved alongside these files in the artifact's notices directory. Node has its complete bundled LICENSE in the private runtime directory; the npm package notices cover sharp, SQLite and the JavaScript dependencies.

GPL-3.0.txt and LGPL-3.0.txt are the full upstream license texts, obtained from https://www.gnu.org/licenses/gpl-3.0.txt and https://www.gnu.org/licenses/lgpl-3.0.txt. These licenses apply to the native components identified by their package notices, not automatically to all ORE code.

Corresponding native-library sources are freely available at the exact component/version URLs in libvips-sources.json. That file includes each source archive and patch used by the pinned upstream packaging recipe. libvips-versions.properties records the version inputs. libvips-build-posix.sh is an unexecuted copy of the v1.3.4 build recipe supplied for reference; platform settings and remaining build files are available at https://github.com/lovell/sharp-libvips/tree/v1.3.4 . Download that complete upstream tree when rebuilding. Its source archives include the individual copyright/license notices and further vendored dependency lockfiles.

Users may replace the separate shared libraries with compatible rebuilt versions. ORE does not require them to be embedded into its executable, and does not impose an additional restriction on studying or modifying those libraries. See the component licenses for the applicable permissions and conditions. The ordinary ORE bootstrap uses the prebuilt binaries and never executes this reference recipe or installs its compiler toolchain.
