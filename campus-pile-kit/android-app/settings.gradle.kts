// 长安大学充电桩查询 · 安卓壳工程
// 只有一个模块：app。工程本身就是个 WebView 壳，不打包任何网页资源，
// 所以这里不需要复杂的多模块拆分。
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "chd-charge-app"
include(":app")
