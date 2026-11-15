# Debug builds are not minified; these only matter for a future release build.
-keepattributes *Annotation*, InnerClasses
-keep,includedescriptorclasses class com.erkantaylan.listenalong.**$$serializer { *; }
-keepclassmembers class com.erkantaylan.listenalong.** {
    *** Companion;
}

# WorkManager stores a work request's worker class by name and creates it by
# reflection, also after an update. WorkManager's own rules keep a worker only
# when something references it, so a shim for an old name is stripped. Keep
# every worker name a released version could have stored, and today's
# (LegacyWorkerNamesTest checks this list):
#   android-v0.2.0 .. android-v0.4.0: download.DownloadWorker (now a shim)
-keep class com.erkantaylan.listenalong.download.DownloadWorker { public <init>(android.content.Context, androidx.work.WorkerParameters); }
-keep class com.erkantaylan.listenalong.core.download.DownloadWorker { public <init>(android.content.Context, androidx.work.WorkerParameters); }
-keep class com.erkantaylan.listenalong.core.download.PlaylistSyncWorker { public <init>(android.content.Context, androidx.work.WorkerParameters); }
